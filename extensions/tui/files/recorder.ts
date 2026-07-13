/**
 * Files Extension — Change Recorder (追踪引擎)
 *
 * 自动记录 pi 会话中所有工具引起的文件变更，包括：
 * - write/edit 工具调用写入的文件（含非项目路径）
 * - bash/exec 命令执行后 git 仓库中产生的新变更
 * - 命令输出文本中检测到的文件路径
 *
 * 供 /changes 命令及 file scanner 消费。
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "@zenone/pi-logger";
import type { ChangeRecord, ChangeSource } from "./types.js";
import { resolveGitRoot, takeGitSnapshot } from "./git.js";

const log = createLogger("files:recorder");

// ── State ──────────────────────────────────────────────────────────────────

const allChanges = new Map<string, ChangeRecord>();
let currentCwd = "";
let currentGitRoot: string | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizePath(raw: string): string {
	const resolved = path.isAbsolute(raw) ? raw : path.resolve(currentCwd, raw);
	const normalized = path.normalize(resolved);
	try {
		return existsSync(normalized) ? realpathSync(normalized) : normalized;
	} catch {
		return normalized;
	}
}

function displayPath(absPath: string): string {
	if (currentGitRoot && absPath.startsWith(currentGitRoot + path.sep)) {
		return "./" + path.relative(currentGitRoot, absPath);
	}
	if (absPath.startsWith(currentCwd + path.sep)) {
		return "./" + path.relative(currentCwd, absPath);
	}
	const home = os.homedir();
	if (absPath.startsWith(home)) {
		return "~" + absPath.slice(home.length);
	}
	return absPath;
}

function record(filePath: string, source: ChangeSource) {
	const canonical = normalizePath(filePath);
	const existing = allChanges.get(canonical);
	if (existing) {
		existing.timestamp = Date.now();
		existing.count++;
		if (source === "write" || source === "edit") existing.source = source;
	} else {
		allChanges.set(canonical, {
			path: canonical,
			display: displayPath(canonical),
			source,
			timestamp: Date.now(),
			count: 1,
		});
	}
	log.debug("记录变更", { path: displayPath(canonical), source });
}

// ── Text Path Extraction ───────────────────────────────────────────────────

function extractPathsFromText(text: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();

	const absRe =
		/(?:\s|^|['"\`(])(\/[^\s"'`<>)}\]/]*\/[^\s"'`<>)}\]/]+\.[a-zA-Z0-9]+)/g;
	for (const m of text.matchAll(absRe)) {
		const p = m[1].replace(/[.,;:]+$/, "").replace(/#L\d.*$/, "");
		if (!seen.has(p) && existsSync(p) && !statSync(p).isDirectory()) {
			seen.add(p);
			found.push(p);
		}
	}

	const homeRe =
		/(?:\s|^|['"\`(])(~\/(?:[^\s"'`<>)}\]/]+\/)*[^\s"'`<>)}\]/]+\.[a-zA-Z0-9]+)/g;
	const homeDir = os.homedir();
	for (const m of text.matchAll(homeRe)) {
		const raw = m[1].replace(/[.,;:]+$/, "");
		const p = path.resolve(homeDir, raw.slice(2));
		if (!seen.has(p) && existsSync(p) && !statSync(p).isDirectory()) {
			seen.add(p);
			found.push(p);
		}
	}

	const relRe = /(?:\s|^|['"\`(])(\.\.?\/[^\s"'`<>)}\]|]+)/g;
	for (const m of text.matchAll(relRe)) {
		const raw = m[1].replace(/[.,;:]+$/, "");
		const p = path.resolve(currentCwd, raw);
		if (!seen.has(p) && existsSync(p) && !statSync(p).isDirectory()) {
			seen.add(p);
			found.push(p);
		}
	}

	return found;
}

function extractResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!Array.isArray(result)) return "";
	return result
		.map((block) => (block?.type === "text" ? String(block.text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getAllChanges(): ChangeRecord[] {
	return Array.from(allChanges.values()).sort(
		(a, b) => b.timestamp - a.timestamp,
	);
}

export function getChangeCount(): number {
	return allChanges.size;
}

export function clearChanges(): void {
	allChanges.clear();
	log.info("变更记录被清空");
}

export function getChangePaths(): string[] {
	return Array.from(allChanges.keys());
}

export function setupRecorder(pi: ExtensionAPI): void {
	log.info("recorder 初始化");

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		currentCwd = ctx.cwd;
		allChanges.clear();
		currentGitRoot = await resolveGitRoot(pi, ctx.cwd);
		log.info("会话开始，变更记录已重置", { currentGitRoot });
	});

	pi.on(
		"tool_execution_end",
		async (event: { toolName: string; result: unknown; isError: boolean }) => {
			const { toolName, result } = event;

			if (toolName === "bash" || toolName === "exec") {
				try {
					if (currentGitRoot) {
						const snapshot = await takeGitSnapshot(pi, currentGitRoot);
						for (const [filePath] of snapshot) {
							const absPath = path.resolve(currentGitRoot, filePath);
							record(absPath, "bash_result");
						}
					}

					const text = extractResultText(result);
					if (text) {
						for (const p of extractPathsFromText(text)) {
							record(p, "output_detected");
						}
					}
				} catch (err) {
					log.error("bash/exec 后分析失败", { error: String(err) });
				}
			}
		},
	);

	pi.on(
		"tool_call",
		async (event: { toolName: string; input: Record<string, unknown> }) => {
			if (event.toolName !== "write" && event.toolName !== "edit") return;

			const DIRECT_PATH_KEYS = [
				"path",
				"filePath",
				"filepath",
				"fileName",
				"filename",
			] as const;

			for (const key of DIRECT_PATH_KEYS) {
				const val = event.input[key];
				if (typeof val === "string") {
					log.debug("tool_call 捕获路径", {
						toolName: event.toolName,
						key,
						path: val,
					});
					record(val, event.toolName as ChangeSource);
					return;
				}
			}
		},
	);
}
