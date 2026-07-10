/**
 * Files Extension（文件浏览器）
 *
 * /files 命令列出当前 git 仓库中的文件（以及会话中引用/修改过的文件），
 * 并提供快速操作：在 Finder 中显示、打开、编辑、diff、Quick Look、添加到提示词等。
 * /diff 命令直接打开文件选择器，选中 tracked 文件后自动打开 VS Code diff 视图。
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("files");

type ContentBlock = {
	type?: string;
	text?: string;
	arguments?: Record<string, unknown>;
};

type FileReference = {
	path: string;
	display: string;
	exists: boolean;
	isDirectory: boolean;
};

type FileEntry = {
	canonicalPath: string;
	resolvedPath: string;
	displayPath: string;
	exists: boolean;
	isDirectory: boolean;
	status?: string;
	inRepo: boolean;
	isTracked: boolean;
	isReferenced: boolean;
	hasSessionChange: boolean;
	lastTimestamp: number;
};

type GitStatusEntry = {
	status: string;
	exists: boolean;
	isDirectory: boolean;
};

type FileToolName = "write" | "edit";

type SessionFileChange = {
	operations: Set<FileToolName>;
	lastTimestamp: number;
};

const FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
const FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

const MAX_EDIT_BYTES = 40 * 1024 * 1024;

const extractFileReferencesFromText = (text: string): string[] => {
	const refs: string[] = [];

	for (const match of text.matchAll(FILE_TAG_REGEX)) {
		refs.push(match[1]);
	}

	for (const match of text.matchAll(FILE_URL_REGEX)) {
		refs.push(match[0]);
	}

	for (const match of text.matchAll(PATH_REGEX)) {
		refs.push(match[1]);
	}

	return refs;
};

const extractPathsFromToolArgs = (args: unknown): string[] => {
	if (!args || typeof args !== "object") {
		return [];
	}

	const refs: string[] = [];
	const record = args as Record<string, unknown>;
	const directKeys = [
		"path",
		"file",
		"filePath",
		"filepath",
		"fileName",
		"filename",
	] as const;
	const listKeys = ["paths", "files", "filePaths"] as const;

	for (const key of directKeys) {
		const value = record[key];
		if (typeof value === "string") {
			refs.push(value);
		}
	}

	for (const key of listKeys) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") {
					refs.push(item);
				}
			}
		}
	}

	return refs;
};

const extractFileReferencesFromContent = (content: unknown): string[] => {
	if (typeof content === "string") {
		return extractFileReferencesFromText(content);
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const refs: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;

		if (block.type === "text" && typeof block.text === "string") {
			refs.push(...extractFileReferencesFromText(block.text));
		}

		if (block.type === "toolCall") {
			refs.push(...extractPathsFromToolArgs(block.arguments));
		}
	}

	return refs;
};

const extractFileReferencesFromEntry = (entry: SessionEntry): string[] => {
	if (entry.type === "message") {
		return "content" in entry.message
			? extractFileReferencesFromContent(entry.message.content)
			: [];
	}

	if (entry.type === "custom_message") {
		return extractFileReferencesFromContent(entry.content);
	}

	return [];
};

const sanitizeReference = (raw: string): string => {
	let value = raw.trim();
	value = value.replace(/^["'`(<\[]+/, "");
	value = value.replace(/[>"'`,;).\]]+$/, "");
	value = value.replace(/[.,;:]+$/, "");
	return value;
};

const isCommentLikeReference = (value: string): boolean =>
	value.startsWith("//");

const stripLineSuffix = (value: string): string => {
	let result = value.replace(/#L\d+(C\d+)?$/i, "");
	const lastSeparator = Math.max(
		result.lastIndexOf("/"),
		result.lastIndexOf("\\"),
	);
	const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
	const segment = result.slice(segmentStart);
	const colonIndex = segment.indexOf(":");
	if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? "")) {
		result = result.slice(0, segmentStart + colonIndex);
		return result;
	}

	const lastColon = result.lastIndexOf(":");
	if (lastColon > lastSeparator) {
		const suffix = result.slice(lastColon + 1);
		if (/^\d+(?::\d+)?$/.test(suffix)) {
			result = result.slice(0, lastColon);
		}
	}
	return result;
};

const normalizeReferencePath = (raw: string, cwd: string): string | null => {
	let candidate = sanitizeReference(raw);
	if (!candidate || isCommentLikeReference(candidate)) {
		return null;
	}

	if (candidate.startsWith("file://")) {
		try {
			candidate = fileURLToPath(candidate);
		} catch {
			return null;
		}
	}

	candidate = stripLineSuffix(candidate);
	if (!candidate || isCommentLikeReference(candidate)) {
		return null;
	}

	if (candidate.startsWith("~")) {
		candidate = path.join(os.homedir(), candidate.slice(1));
	}

	if (!path.isAbsolute(candidate)) {
		candidate = path.resolve(cwd, candidate);
	}

	candidate = path.normalize(candidate);
	const root = path.parse(candidate).root;
	if (candidate.length > root.length) {
		candidate = candidate.replace(/[\\/]+$/, "");
	}

	return candidate;
};

const formatDisplayPath = (absolutePath: string, cwd: string): string => {
	const normalizedCwd = path.resolve(cwd);
	if (absolutePath.startsWith(normalizedCwd + path.sep)) {
		return path.relative(normalizedCwd, absolutePath);
	}

	return absolutePath;
};

const collectRecentFileReferences = (
	entries: SessionEntry[],
	cwd: string,
	limit: number,
): FileReference[] => {
	const results: FileReference[] = [];
	const seen = new Set<string>();

	for (let i = entries.length - 1; i >= 0 && results.length < limit; i -= 1) {
		const refs = extractFileReferencesFromEntry(entries[i]);
		for (let j = refs.length - 1; j >= 0 && results.length < limit; j -= 1) {
			const normalized = normalizeReferencePath(refs[j], cwd);
			if (!normalized || seen.has(normalized)) {
				continue;
			}

			seen.add(normalized);

			let exists = false;
			let isDirectory = false;
			if (existsSync(normalized)) {
				exists = true;
				const stats = statSync(normalized);
				isDirectory = stats.isDirectory();
			}

			results.push({
				path: normalized,
				display: formatDisplayPath(normalized, cwd),
				exists,
				isDirectory,
			});
		}
	}

	return results;
};

const findLatestFileReference = (
	entries: SessionEntry[],
	cwd: string,
): FileReference | null => {
	const refs = collectRecentFileReferences(entries, cwd, 100);
	return refs.find((ref) => ref.exists) ?? null;
};

const toCanonicalPath = (
	inputPath: string,
): { canonicalPath: string; isDirectory: boolean } | null => {
	if (!existsSync(inputPath)) {
		return null;
	}

	try {
		const canonicalPath = realpathSync(inputPath);
		const stats = statSync(canonicalPath);
		return { canonicalPath, isDirectory: stats.isDirectory() };
	} catch {
		return null;
	}
};

const toCanonicalPathMaybeMissing = (
	inputPath: string,
): { canonicalPath: string; isDirectory: boolean; exists: boolean } | null => {
	const resolvedPath = path.resolve(inputPath);
	if (!existsSync(resolvedPath)) {
		return {
			canonicalPath: path.normalize(resolvedPath),
			isDirectory: false,
			exists: false,
		};
	}

	try {
		const canonicalPath = realpathSync(resolvedPath);
		const stats = statSync(canonicalPath);
		return { canonicalPath, isDirectory: stats.isDirectory(), exists: true };
	} catch {
		return {
			canonicalPath: path.normalize(resolvedPath),
			isDirectory: false,
			exists: true,
		};
	}
};

const collectSessionFileChanges = (
	entries: SessionEntry[],
	cwd: string,
): Map<string, SessionFileChange> => {
	const toolCalls = new Map<string, { path: string; name: FileToolName }>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const name = block.name as FileToolName;
					if (name === "write" || name === "edit") {
						const filePath = block.arguments?.path;
						if (filePath && typeof filePath === "string") {
							toolCalls.set(block.id, { path: filePath, name });
						}
					}
				}
			}
		}
	}

	const fileMap = new Map<string, SessionFileChange>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "toolResult") {
			const toolCall = toolCalls.get(msg.toolCallId);
			if (!toolCall) continue;

			const resolvedPath = path.isAbsolute(toolCall.path)
				? toolCall.path
				: path.resolve(cwd, toolCall.path);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) {
				continue;
			}

			const existing = fileMap.get(canonical.canonicalPath);
			if (existing) {
				existing.operations.add(toolCall.name);
				if (msg.timestamp > existing.lastTimestamp) {
					existing.lastTimestamp = msg.timestamp;
				}
			} else {
				fileMap.set(canonical.canonicalPath, {
					operations: new Set([toolCall.name]),
					lastTimestamp: msg.timestamp,
				});
			}
		}
	}

	return fileMap;
};

const splitNullSeparated = (value: string): string[] =>
	value.split("\0").filter(Boolean);

const getGitRoot = async (
	pi: ExtensionAPI,
	cwd: string,
): Promise<string | null> => {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
		cwd,
	});
	if (result.code !== 0) {
		return null;
	}

	const root = result.stdout.trim();
	return root ? root : null;
};

const getGitStatusMap = async (
	pi: ExtensionAPI,
	cwd: string,
): Promise<Map<string, GitStatusEntry>> => {
	const statusMap = new Map<string, GitStatusEntry>();
	const statusResult = await pi.exec("git", ["status", "--porcelain=1", "-z"], {
		cwd,
	});
	if (statusResult.code !== 0 || !statusResult.stdout) {
		return statusMap;
	}

	const entries = splitNullSeparated(statusResult.stdout);
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		if (!entry || entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const statusLabel = status.replace(/\s/g, "") || status.trim();
		let filePath = entry.slice(3);
		if ((status.startsWith("R") || status.startsWith("C")) && entries[i + 1]) {
			filePath = entries[i + 1];
			i += 1;
		}
		if (!filePath) continue;

		const resolved = path.isAbsolute(filePath)
			? filePath
			: path.resolve(cwd, filePath);
		const canonical = toCanonicalPathMaybeMissing(resolved);
		if (!canonical) continue;
		statusMap.set(canonical.canonicalPath, {
			status: statusLabel,
			exists: canonical.exists,
			isDirectory: canonical.isDirectory,
		});
	}

	return statusMap;
};

const getGitFiles = async (
	pi: ExtensionAPI,
	gitRoot: string,
): Promise<{
	tracked: Set<string>;
	files: Array<{ canonicalPath: string; isDirectory: boolean }>;
}> => {
	const tracked = new Set<string>();
	const files: Array<{ canonicalPath: string; isDirectory: boolean }> = [];

	const trackedResult = await pi.exec("git", ["ls-files", "-z"], {
		cwd: gitRoot,
	});
	if (trackedResult.code === 0 && trackedResult.stdout) {
		for (const relativePath of splitNullSeparated(trackedResult.stdout)) {
			const resolvedPath = path.resolve(gitRoot, relativePath);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) continue;
			tracked.add(canonical.canonicalPath);
			files.push(canonical);
		}
	}

	const untrackedResult = await pi.exec(
		"git",
		["ls-files", "-z", "--others", "--exclude-standard"],
		{ cwd: gitRoot },
	);
	if (untrackedResult.code === 0 && untrackedResult.stdout) {
		for (const relativePath of splitNullSeparated(untrackedResult.stdout)) {
			const resolvedPath = path.resolve(gitRoot, relativePath);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) continue;
			files.push(canonical);
		}
	}

	return { tracked, files };
};

const buildFileEntries = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<{ files: FileEntry[]; gitRoot: string | null }> => {
	const entries = ctx.sessionManager.getBranch();
	const sessionChanges = collectSessionFileChanges(entries, ctx.cwd);
	const gitRoot = await getGitRoot(pi, ctx.cwd);
	const statusMap = gitRoot
		? await getGitStatusMap(pi, gitRoot)
		: new Map<string, GitStatusEntry>();

	let trackedSet = new Set<string>();
	let gitFiles: Array<{ canonicalPath: string; isDirectory: boolean }> = [];
	if (gitRoot) {
		const gitListing = await getGitFiles(pi, gitRoot);
		trackedSet = gitListing.tracked;
		gitFiles = gitListing.files;
	}

	const fileMap = new Map<string, FileEntry>();

	const upsertFile = (
		data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean },
	) => {
		const existing = fileMap.get(data.canonicalPath);
		const displayPath =
			data.displayPath ?? formatDisplayPath(data.canonicalPath, ctx.cwd);

		if (existing) {
			fileMap.set(data.canonicalPath, {
				...existing,
				...data,
				displayPath,
				exists: data.exists ?? existing.exists,
				isDirectory: data.isDirectory ?? existing.isDirectory,
				isReferenced: existing.isReferenced || data.isReferenced === true,
				inRepo: existing.inRepo || data.inRepo === true,
				isTracked: existing.isTracked || data.isTracked === true,
				hasSessionChange:
					existing.hasSessionChange || data.hasSessionChange === true,
				lastTimestamp: Math.max(
					existing.lastTimestamp,
					data.lastTimestamp ?? 0,
				),
			});
			return;
		}

		fileMap.set(data.canonicalPath, {
			canonicalPath: data.canonicalPath,
			resolvedPath: data.resolvedPath ?? data.canonicalPath,
			displayPath,
			exists: data.exists ?? true,
			isDirectory: data.isDirectory,
			status: data.status,
			inRepo: data.inRepo ?? false,
			isTracked: data.isTracked ?? false,
			isReferenced: data.isReferenced ?? false,
			hasSessionChange: data.hasSessionChange ?? false,
			lastTimestamp: data.lastTimestamp ?? 0,
		});
	};

	for (const file of gitFiles) {
		upsertFile({
			canonicalPath: file.canonicalPath,
			resolvedPath: file.canonicalPath,
			isDirectory: file.isDirectory,
			exists: true,
			status: statusMap.get(file.canonicalPath)?.status,
			inRepo: true,
			isTracked: trackedSet.has(file.canonicalPath),
		});
	}

	for (const [canonicalPath, statusEntry] of statusMap.entries()) {
		if (fileMap.has(canonicalPath)) {
			continue;
		}

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonicalPath));

		upsertFile({
			canonicalPath,
			resolvedPath: canonicalPath,
			isDirectory: statusEntry.isDirectory,
			exists: statusEntry.exists,
			status: statusEntry.status,
			inRepo,
			isTracked: trackedSet.has(canonicalPath) || statusEntry.status !== "??",
		});
	}

	const references = collectRecentFileReferences(entries, ctx.cwd, 200).filter(
		(ref) => ref.exists,
	);
	for (const ref of references) {
		const canonical = toCanonicalPath(ref.path);
		if (!canonical) continue;

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonical.canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonical.canonicalPath));

		upsertFile({
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			isDirectory: canonical.isDirectory,
			exists: true,
			status: statusMap.get(canonical.canonicalPath)?.status,
			inRepo,
			isTracked: trackedSet.has(canonical.canonicalPath),
			isReferenced: true,
		});
	}

	for (const [canonicalPath, change] of sessionChanges.entries()) {
		const canonical = toCanonicalPath(canonicalPath);
		if (!canonical) continue;

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonical.canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonical.canonicalPath));

		upsertFile({
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			isDirectory: canonical.isDirectory,
			exists: true,
			status: statusMap.get(canonical.canonicalPath)?.status,
			inRepo,
			isTracked: trackedSet.has(canonical.canonicalPath),
			hasSessionChange: true,
			lastTimestamp: change.lastTimestamp,
		});
	}

	const files = Array.from(fileMap.values()).sort((a, b) => {
		const aDirty = Boolean(a.status);
		const bDirty = Boolean(b.status);
		if (aDirty !== bDirty) {
			return aDirty ? -1 : 1;
		}
		if (a.inRepo !== b.inRepo) {
			return a.inRepo ? -1 : 1;
		}
		if (a.hasSessionChange !== b.hasSessionChange) {
			return a.hasSessionChange ? -1 : 1;
		}
		if (a.lastTimestamp !== b.lastTimestamp) {
			return b.lastTimestamp - a.lastTimestamp;
		}
		if (a.isReferenced !== b.isReferenced) {
			return a.isReferenced ? -1 : 1;
		}
		return a.displayPath.localeCompare(b.displayPath);
	});

	return { files, gitRoot };
};

type EditCheckResult = {
	allowed: boolean;
	reason?: string;
	content?: string;
};

const getEditableContent = (target: FileEntry): EditCheckResult => {
	if (!existsSync(target.resolvedPath)) {
		return { allowed: false, reason: "File not found" };
	}

	const stats = statSync(target.resolvedPath);
	if (stats.isDirectory()) {
		return { allowed: false, reason: "Directories cannot be edited" };
	}

	if (stats.size >= MAX_EDIT_BYTES) {
		return { allowed: false, reason: "File is too large" };
	}

	const buffer = readFileSync(target.resolvedPath);
	if (buffer.includes(0)) {
		return { allowed: false, reason: "File contains null bytes" };
	}

	return { allowed: true, content: buffer.toString("utf8") };
};

const showActionSelector = async (
	ctx: ExtensionContext,
	options: {
		canQuickLook: boolean;
		canEdit: boolean;
		canViewChanges: boolean;
		canFileDiff: boolean;
	},
): Promise<
	| "reveal"
	| "quicklook"
	| "open"
	| "edit"
	| "addToPrompt"
	| "viewChanges"
	| "fileDiff"
	| null
> => {
	const actions: SelectItem[] = [
		...(options.canViewChanges
			? [{ value: "viewChanges", label: "查看 git 变更" }]
			: []),
		...(options.canFileDiff
			? [{ value: "fileDiff", label: "进行 diff 对比" }]
			: []),
		{ value: "reveal", label: "在 Finder 中显示" },
		{ value: "open", label: "打开" },
		{ value: "addToPrompt", label: "添加到提示词" },
		...(options.canQuickLook
			? [{ value: "quicklook", label: "Quick Look 预览" }]
			: []),
		...(options.canEdit ? [{ value: "edit", label: "编辑" }] : []),
	];

	return ctx.ui.custom<
		| "reveal"
		| "quicklook"
		| "open"
		| "edit"
		| "addToPrompt"
		| "viewChanges"
		| "fileDiff"
		| null
	>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Choose action"))),
		);

		const selectList = new SelectList(actions, actions.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) =>
			done(
				item.value as
					| "reveal"
					| "quicklook"
					| "open"
					| "edit"
					| "addToPrompt"
					| "viewChanges"
					| "fileDiff",
			);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(
			new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")),
		);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

const openPath = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileEntry,
): Promise<void> => {
	if (!existsSync(target.resolvedPath)) {
		log.warn("openPath 失败：文件不存在", { 路径: target.displayPath });
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const command = process.platform === "darwin" ? "open" : "xdg-open";
	const result = await pi.exec(command, [target.resolvedPath]);
	if (result.code !== 0) {
		const errorMessage =
			result.stderr?.trim() || `Failed to open ${target.displayPath}`;
		log.error("openPath 执行失败", {
			命令: command,
			路径: target.displayPath,
			错误: errorMessage,
		});
		ctx.ui.notify(errorMessage, "error");
		return;
	}
	log.debug("openPath 成功", { 路径: target.displayPath });
};

const openExternalEditor = (
	tui: TUI,
	editorCmd: string,
	content: string,
): string | null => {
	const tmpFile = path.join(os.tmpdir(), `pi-files-edit-${Date.now()}.txt`);

	try {
		writeFileSync(tmpFile, content, "utf8");
		tui.stop();

		const [editor, ...editorArgs] = editorCmd.split(" ");
		const result = spawnSync(editor, [...editorArgs, tmpFile], {
			stdio: "inherit",
		});

		if (result.status === 0) {
			return readFileSync(tmpFile, "utf8").replace(/\n$/, "");
		}

		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {}
		tui.start();
		tui.requestRender(true);
	}
};

const editPath = async (
	ctx: ExtensionContext,
	target: FileEntry,
	content: string,
): Promise<void> => {
	const editorCmd = process.env.VISUAL || process.env.EDITOR;
	if (!editorCmd) {
		log.warn("editPath 跳过：未设置 $VISUAL/$EDITOR");
		ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
		return;
	}

	log.debug("editPath 启动外部编辑器", {
		编辑器: editorCmd,
		文件: target.displayPath,
	});
	const updated = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			const status = new Text(theme.fg("dim", `Opening ${editorCmd}...`));

			queueMicrotask(() => {
				const result = openExternalEditor(tui, editorCmd, content);
				done(result);
			});

			return status;
		},
	);

	if (updated === null) {
		log.info("editPath 取消编辑", { 文件: target.displayPath });
		ctx.ui.notify("Edit cancelled", "info");
		return;
	}

	try {
		writeFileSync(target.resolvedPath, updated, "utf8");
		log.info("editPath 保存成功", { 文件: target.displayPath });
	} catch (err) {
		log.error("editPath 保存失败", {
			文件: target.displayPath,
			错误: String(err),
		});
		ctx.ui.notify(`Failed to save ${target.displayPath}`, "error");
	}
};

const revealPath = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileEntry,
): Promise<void> => {
	if (!existsSync(target.resolvedPath)) {
		log.warn("revealPath 失败：文件不存在", { 路径: target.displayPath });
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const isDirectory =
		target.isDirectory || statSync(target.resolvedPath).isDirectory();
	let command = "open";
	let args: string[] = [];

	if (process.platform === "darwin") {
		args = isDirectory ? [target.resolvedPath] : ["-R", target.resolvedPath];
	} else {
		command = "xdg-open";
		args = [
			isDirectory ? target.resolvedPath : path.dirname(target.resolvedPath),
		];
	}

	log.debug("revealPath 执行", {
		路径: target.displayPath,
		命令: command,
		参数: args,
	});
	const result = await pi.exec(command, args);
	if (result.code !== 0) {
		const errorMessage =
			result.stderr?.trim() || `Failed to reveal ${target.displayPath}`;
		log.error("revealPath 执行失败", {
			路径: target.displayPath,
			错误: errorMessage,
		});
		ctx.ui.notify(errorMessage, "error");
	}
};

const quickLookPath = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileEntry,
): Promise<void> => {
	if (process.platform !== "darwin") {
		log.warn("quickLookPath 跳过：非 macOS 平台");
		ctx.ui.notify("Quick Look is only available on macOS", "warning");
		return;
	}

	if (!existsSync(target.resolvedPath)) {
		log.warn("quickLookPath 失败：文件不存在", { 路径: target.displayPath });
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const isDirectory =
		target.isDirectory || statSync(target.resolvedPath).isDirectory();
	if (isDirectory) {
		log.warn("quickLookPath 跳过：不支持目录", { 路径: target.displayPath });
		ctx.ui.notify("Quick Look only works on files", "warning");
		return;
	}

	log.debug("quickLookPath 执行", { 路径: target.displayPath });
	const result = await pi.exec("qlmanage", ["-p", target.resolvedPath]);
	if (result.code !== 0) {
		const errorMessage =
			result.stderr?.trim() || `Failed to Quick Look ${target.displayPath}`;
		log.error("quickLookPath 执行失败", {
			路径: target.displayPath,
			错误: errorMessage,
		});
		ctx.ui.notify(errorMessage, "error");
	}
};

const getDiffToolCommand = async (
	pi: ExtensionAPI,
): Promise<{
	cmd: string;
	args: (left: string, right: string) => string[];
} | null> => {
	// 1. 检测 $VISUAL/$EDITOR → 使用 nvim -d / vimdiff
	const editorCmd = process.env.VISUAL || process.env.EDITOR || "";
	const editorBase = path.basename(editorCmd.split(" ")[0] ?? "");
	if (editorBase.includes("nvim") || editorBase === "neovim") {
		log.debug("检测到 $EDITOR=nvim，使用 nvim -d --clean");
		return {
			cmd: "nvim",
			args: (left, right) => ["-d", "--clean", left, right],
		};
	}
	if (editorBase.includes("vim")) {
		log.debug("检测到 $EDITOR=vim，使用 vimdiff");
		return {
			cmd: "vimdiff",
			args: (left, right) => [left, right],
		};
	}

	// 2. 检测 git difftool（尊重用户 git config 配置的 difftool）
	const difftoolCheck = await pi.exec("git", ["config", "--get", "diff.tool"]);
	if (difftoolCheck.code === 0 && difftoolCheck.stdout.trim()) {
		log.debug("检测到 git difftool 配置，使用 git difftool", {
			工具: difftoolCheck.stdout.trim(),
		});
		return {
			cmd: "git",
			args: (left, right) => [
				"difftool",
				"--no-prompt",
				"--tool",
				difftoolCheck.stdout.trim(),
				left,
				right,
			],
		};
	}

	// 3. 尝试全局 vimdiff
	const vimCheck = await pi.exec("which", ["vimdiff"]);
	if (vimCheck.code === 0) {
		log.debug("使用系统 vimdiff");
		return {
			cmd: "vimdiff",
			args: (left, right) => [left, right],
		};
	}

	// 4. 最后才尝试 VS Code（默认环境）
	const codeCheck = await pi.exec("which", ["code"]);
	if (codeCheck.code === 0 && codeCheck.stdout.trim()) {
		log.debug("未检测到 vim 类工具，回退到 code --diff");
		return {
			cmd: "code",
			args: (left, right) => ["--diff", left, right],
		};
	}

	return null;
};

/** 判断 diff 工具是否是终端类编辑器（vim/nvim 等需要可见终端展示的） */
const isTerminalBasedTool = (cmd: string): boolean => {
	const base = path.basename(cmd);
	return base.includes("vim") || base.includes("nvim") || base === "vi";
};

/** 询问用户如何展示终端类 diff 工具的结果 */
const promptDiffDisplayMode = async (
	ctx: ExtensionContext,
	inTmux: boolean,
): Promise<"panel" | "tmux" | null> => {
	if (!ctx.hasUI) return "panel";

	const options: SelectItem[] = [
		{
			value: "panel",
			label: "Pi 原生面板",
			description: "在 pi 的 TUI 面板中显示 diff 文本",
		},
	];
	if (inTmux) {
		options.push({
			value: "tmux",
			label: "Tmux 新面板",
			description: "在 tmux 分屏中打开 vimdiff",
		});
	}

	return ctx.ui.custom<"panel" | "tmux" | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold(" 选择 diff 展示方式")), 0, 0),
		);

		const list = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value as "panel" | "tmux");
		list.onCancel = () => done(null);

		container.addChild(list);
		container.addChild(
			new Text(theme.fg("dim", "enter 确认 · esc 取消"), 0, 0),
		);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(w: number) {
				return container.render(w);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

/** 在 pi 原生 TUI 面板中展示 diff 文本内容 */
const showDiffInPiPanel = async (
	ctx: ExtensionContext,
	title: string,
	diffContent: string,
): Promise<void> => {
	return ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold(` ${title}`)), 0, 0),
		);
		container.addChild(new Spacer(1));

		const lines = diffContent.split("\n");
		// 预留 4 列边距防止溢出
		const maxLineWidth = 120;
		for (const raw of lines) {
			const line =
				raw.length > maxLineWidth ? truncateToWidth(raw, maxLineWidth) : raw;
			let styled = line;
			if (line.startsWith("+")) {
				styled = theme.fg("success", line);
			} else if (line.startsWith("-")) {
				styled = theme.fg("error", line);
			} else if (line.startsWith("@@")) {
				styled = theme.fg("warning", line);
			} else if (
				line.startsWith("diff --git") ||
				line.startsWith("---") ||
				line.startsWith("+++")
			) {
				styled = theme.fg("accent", line);
			}
			container.addChild(new Text(styled, 0, 0));
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "按 q 或 esc 关闭"), 0, 0));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(w: number) {
				return container.render(w);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (data === "q" || data === "Escape") {
					done(undefined);
				}
			},
		};
	});
};

/** 在 tmux 中创建新分屏并运行 diff 命令 */
const showDiffInTmuxSplit = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cmd: string,
	args: string[],
	cwd: string,
): Promise<void> => {
	const quotedArgs = args.map((a) => (a.includes(" ") ? `"${a}"` : a));
	const fullCmd = `${cmd} ${quotedArgs.join(" ")}`;

	log.info("在 tmux 中创建新窗口", { 命令: fullCmd });

	// 不指定 -t，让 tmux 在当前 session 自动分配索引创建新窗口
	const result = await pi.exec("tmux", ["new-window", "-c", cwd, fullCmd]);
	if (result.code !== 0) {
		const errMsg = result.stderr?.trim() || "tmux new-window failed";
		log.error("tmux 新窗口失败", { 错误: errMsg });
		ctx.ui.notify(`Tmux new-window failed: ${errMsg}`, "error");
		return;
	}
	ctx.ui.notify("Diff opened in tmux new window", "info");
};

const openDiff = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileEntry,
	gitRoot: string | null,
): Promise<void> => {
	if (!gitRoot) {
		log.warn("openDiff 跳过：无 git 仓库");
		ctx.ui.notify("Git repository not found", "warning");
		return;
	}

	const relativePath = path
		.relative(gitRoot, target.resolvedPath)
		.split(path.sep)
		.join("/");
	log.debug("openDiff 开始", { 文件: target.displayPath, relativePath });

	const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-files-"));
	const tmpFile = path.join(tmpDir, path.basename(target.displayPath));

	const existsInHead = await pi.exec(
		"git",
		["cat-file", "-e", `HEAD:${relativePath}`],
		{ cwd: gitRoot },
	);
	if (existsInHead.code === 0) {
		const result = await pi.exec("git", ["show", `HEAD:${relativePath}`], {
			cwd: gitRoot,
		});
		if (result.code !== 0) {
			const errorMessage =
				result.stderr?.trim() || `Failed to diff ${target.displayPath}`;
			log.error("openDiff 获取 HEAD 版本失败", {
				文件: target.displayPath,
				错误: errorMessage,
			});
			ctx.ui.notify(errorMessage, "error");
			return;
		}
		writeFileSync(tmpFile, result.stdout ?? "", "utf8");
	} else {
		log.debug("openDiff 文件在 HEAD 中不存在，使用空文件对比", {
			文件: target.displayPath,
		});
		writeFileSync(tmpFile, "", "utf8");
	}

	let workingPath = target.resolvedPath;
	if (!existsSync(target.resolvedPath)) {
		workingPath = path.join(
			tmpDir,
			`pi-files-working-${path.basename(target.displayPath)}`,
		);
		writeFileSync(workingPath, "", "utf8");
	}

	// 自动检测系统默认 diff 工具
	const diffTool = await getDiffToolCommand(pi);
	if (!diffTool) {
		const msg = "No diff tool found (code, vimdiff, or git difftool)";
		log.error("openDiff 失败：" + msg);
		ctx.ui.notify(msg, "error");
		return;
	}

	log.info("openDiff: 使用 diff 工具", {
		文件: target.displayPath,
		工具: diffTool.cmd,
		左: tmpFile,
		右: workingPath,
	});

	if (isTerminalBasedTool(diffTool.cmd)) {
		// 终端编辑器 → 询问展示方式
		const inTmux = !!process.env.TMUX;
		const mode = await promptDiffDisplayMode(ctx, inTmux);
		if (!mode) {
			log.info("openDiff 用户取消 diff");
			return;
		}

		if (mode === "tmux") {
			const diffArgs = diffTool.args(tmpFile, workingPath);
			await showDiffInTmuxSplit(pi, ctx, diffTool.cmd, diffArgs, gitRoot);
			log.debug("openDiff tmux 分屏完成", { 文件: target.displayPath });
			return;
		}

		// Pi 原生面板：获取 git diff 文本并展示
		const gitDiffResult = await pi.exec(
			"git",
			["diff", "HEAD", "--", relativePath],
			{ cwd: gitRoot },
		);
		const diffText =
			gitDiffResult.code === 0 && gitDiffResult.stdout
				? gitDiffResult.stdout
				: `(no diff output for ${target.displayPath})`;
		await showDiffInPiPanel(ctx, `Git 变更: ${target.displayPath}`, diffText);
		log.debug("openDiff pi 面板展示完成", { 文件: target.displayPath });
		return;
	}

	// GUI 工具（code --diff 等）→ 直接执行
	const diffArgs = diffTool.args(tmpFile, workingPath);
	const openResult = await pi.exec(diffTool.cmd, diffArgs, {
		cwd: gitRoot,
	});
	if (openResult.code !== 0) {
		const errorMessage =
			openResult.stderr?.trim() ||
			`Failed to open diff for ${target.displayPath}`;
		log.error("openDiff 打开 diff 失败", {
			文件: target.displayPath,
			工具: diffTool.cmd,
			错误: errorMessage,
		});
		ctx.ui.notify(errorMessage, "error");
		return;
	}
	log.debug("openDiff 成功", { 文件: target.displayPath });
};

/**
 * 打开两个文件的 diff 对比（不涉及 git，直接比较文件内容）
 * 使用系统检测到的 diff 工具（code --diff / vimdiff / git difftool）
 */
const openFilesDiff = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	left: FileEntry,
	right: FileEntry,
): Promise<void> => {
	log.info("openFilesDiff 开始", {
		左: left.displayPath,
		右: right.displayPath,
	});

	const diffTool = await getDiffToolCommand(pi);
	if (!diffTool) {
		const msg = "No diff tool found (code, vimdiff, or git difftool)";
		log.error("openFilesDiff 失败：" + msg);
		ctx.ui.notify(msg, "error");
		return;
	}

	const leftPath = existsSync(left.resolvedPath)
		? left.resolvedPath
		: path.join(
				os.tmpdir(),
				`pi-files-empty-left-${path.basename(left.displayPath)}`,
			);
	const rightPath = existsSync(right.resolvedPath)
		? right.resolvedPath
		: path.join(
				os.tmpdir(),
				`pi-files-empty-right-${path.basename(right.displayPath)}`,
			);

	if (!existsSync(left.resolvedPath)) {
		writeFileSync(leftPath, "", "utf8");
	}
	if (!existsSync(right.resolvedPath)) {
		writeFileSync(rightPath, "", "utf8");
	}

	log.info("openFilesDiff: 使用 diff 工具", {
		工具: diffTool.cmd,
		左: leftPath,
		右: rightPath,
	});

	if (isTerminalBasedTool(diffTool.cmd)) {
		// 终端编辑器 → 询问展示方式
		const inTmux = !!process.env.TMUX;
		const mode = await promptDiffDisplayMode(ctx, inTmux);
		if (!mode) {
			log.info("openFilesDiff 用户取消");
			return;
		}

		if (mode === "tmux") {
			const diffArgs = diffTool.args(leftPath, rightPath);
			await showDiffInTmuxSplit(pi, ctx, diffTool.cmd, diffArgs, ctx.cwd);
			log.debug("openFilesDiff tmux 分屏完成");
			return;
		}

		// Pi 原生面板：使用系统 diff 命令获取文本
		const diffResult = await pi.exec("diff", [leftPath, rightPath]);
		const diffText =
			diffResult.code === 0
				? "(两个文件内容一致)"
				: diffResult.stdout || "(diff 无输出)";
		await showDiffInPiPanel(
			ctx,
			`文件对比: ${left.displayPath} ↔ ${right.displayPath}`,
			diffText,
		);
		log.debug("openFilesDiff pi 面板展示完成");
		return;
	}

	// GUI 工具（code --diff 等）→ 直接执行
	const diffArgs = diffTool.args(leftPath, rightPath);
	const openResult = await pi.exec(diffTool.cmd, diffArgs);
	if (openResult.code !== 0) {
		const errorMessage =
			openResult.stderr?.trim() ||
			`Failed to diff ${left.displayPath} vs ${right.displayPath}`;
		log.error("openFilesDiff 打开 diff 失败", {
			工具: diffTool.cmd,
			错误: errorMessage,
		});
		ctx.ui.notify(errorMessage, "error");
		return;
	}
	log.debug("openFilesDiff 成功", {
		左: left.displayPath,
		右: right.displayPath,
	});
};

const addFileToPrompt = (ctx: ExtensionContext, target: FileEntry): void => {
	const mentionTarget = target.displayPath || target.resolvedPath;
	const mention = `@${mentionTarget}`;
	const current = ctx.ui.getEditorText();
	const separator = current && !current.endsWith(" ") ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}${mention}`);
	log.info("addToPrompt: 文件引用已添加到输入框", { 文件: mentionTarget });
	ctx.ui.notify(`Added ${mention} to prompt`, "info");
};

const buildSelectItems = (
	files: FileEntry[],
	selectedPaths: Set<string>,
): SelectItem[] =>
	files.map((file) => {
		const checkbox = selectedPaths.has(file.canonicalPath) ? "☑ " : "☐ ";
		const directoryLabel = file.isDirectory ? " [directory]" : "";
		const statusSuffix = file.status ? ` [${file.status}]` : "";
		return {
			value: file.canonicalPath,
			label: `${checkbox}${file.displayPath}${directoryLabel}${statusSuffix}`,
		};
	});

const showFileSelector = async (
	ctx: ExtensionContext,
	files: FileEntry[],
	selectedPath?: string | null,
	gitRoot?: string | null,
): Promise<{ selected: FileEntry[]; quickAction: "diff" | null }> => {
	const selectedPaths = new Set<string>();
	const allItems = buildSelectItems(files, selectedPaths);

	let quickAction: "diff" | null = null;
	const selectionResult = await ctx.ui.custom<string[] | null>(
		(tui, theme, keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold(" Select file(s)")), 0, 0),
			);

			const searchInput = new Input();
			container.addChild(searchInput);
			container.addChild(new Spacer(1));

			const listContainer = new Container();
			container.addChild(listContainer);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						"Type to filter • space toggle • enter confirm • ctrl+shift+d diff • esc cancel",
					),
					0,
					0,
				),
			);
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			let filteredItems = allItems;
			let selectList: SelectList | null = null;

			const updateList = () => {
				listContainer.clear();
				if (filteredItems.length === 0) {
					listContainer.addChild(
						new Text(theme.fg("warning", "  No matching files"), 0, 0),
					);
					selectList = null;
					return;
				}

				selectList = new SelectList(
					filteredItems,
					Math.min(filteredItems.length, 12),
					{
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				);

				if (selectedPath && !selectedPaths.size) {
					const index = filteredItems.findIndex(
						(item) => item.value === selectedPath,
					);
					if (index >= 0) {
						selectList.setSelectedIndex(index);
					}
				}

				selectList.onSelect = () => {
					const values =
						selectedPaths.size > 0
							? Array.from(selectedPaths)
							: selectList?.getSelectedItem()
								? [selectList.getSelectedItem()!.value]
								: [];
					done(values);
				};
				selectList.onCancel = () => done(null);

				listContainer.addChild(selectList);
			};

			const refreshItems = () => {
				const query = searchInput.getValue();
				const currentItems = buildSelectItems(files, selectedPaths);
				filteredItems = query
					? fuzzyFilter(
							currentItems,
							query,
							(item) => `${item.label} ${item.value} ${item.description ?? ""}`,
						)
					: currentItems;
				updateList();
			};

			const applyFilter = () => {
				const query = searchInput.getValue();
				const currentItems = buildSelectItems(files, selectedPaths);
				filteredItems = query
					? fuzzyFilter(
							currentItems,
							query,
							(item) => `${item.label} ${item.value} ${item.description ?? ""}`,
						)
					: currentItems;
				updateList();
			};

			applyFilter();

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					// Space: toggle multi-select for the focused item
					if (data === " ") {
						const focused = selectList?.getSelectedItem();
						if (focused) {
							const wasSelected = selectedPaths.has(focused.value);
							if (wasSelected) {
								selectedPaths.delete(focused.value);
							} else {
								selectedPaths.add(focused.value);
							}
							log.debug("多选切换", {
								文件: focused.value,
								已选: selectedPaths.size,
							});
							// 保存光标位置后刷新
							const focusedVal = selectList?.getSelectedItem()?.value;
							refreshItems();
							// 恢复光标位置
							if (focusedVal && selectList) {
								const newIdx = filteredItems.findIndex(
									(item) => item.value === focusedVal,
								);
								if (newIdx >= 0) {
									selectList.setSelectedIndex(newIdx);
								}
							}
							tui.requestRender();
						}
						return;
					}

					if (matchesKey(data, "ctrl+shift+d")) {
						const focused = selectList?.getSelectedItem();
						if (focused) {
							const file = files.find(
								(entry) => entry.canonicalPath === focused.value,
							);
							const canDiff =
								file?.isTracked && !file.isDirectory && Boolean(gitRoot);
							if (!canDiff) {
								ctx.ui.notify(
									"Diff is only available for tracked files",
									"warning",
								);
								return;
							}
							quickAction = "diff";
							done([focused.value]);
							return;
						}
					}

					if (
						keybindings.matches(data, "tui.select.up") ||
						keybindings.matches(data, "tui.select.down") ||
						keybindings.matches(data, "tui.select.confirm") ||
						keybindings.matches(data, "tui.select.cancel")
					) {
						if (selectList) {
							selectList.handleInput(data);
						} else if (keybindings.matches(data, "tui.select.cancel")) {
							done(null);
						}
						tui.requestRender();
						return;
					}

					searchInput.handleInput(data);
					applyFilter();
					tui.requestRender();
				},
			};
		},
	);

	const selected = selectionResult
		? selectionResult
				.map((path) => files.find((f) => f.canonicalPath === path))
				.filter((f): f is FileEntry => f !== undefined)
		: [];
	return { selected, quickAction };
};

const runFileBrowser = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> => {
	if (!ctx.hasUI) {
		log.warn("/files 被调用但当前不是交互模式");
		ctx.ui.notify("Files requires interactive mode", "error");
		return;
	}

	log.info("/files 命令启动");
	const { files, gitRoot } = await buildFileEntries(pi, ctx);
	log.debug("文件列表构建完成", { 文件数: files.length, 有Git仓库: !!gitRoot });
	if (files.length === 0) {
		ctx.ui.notify("No files found", "info");
		return;
	}

	let lastSelectedPath: string | null = null;
	while (true) {
		const { selected, quickAction } = await showFileSelector(
			ctx,
			files,
			lastSelectedPath,
			gitRoot,
		);
		if (selected.length === 0) {
			ctx.ui.notify("Files cancelled", "info");
			return;
		}

		// 如果只有单个文件，记住它作为下次的 pre-select
		if (selected.length === 1) {
			lastSelectedPath = selected[0].canonicalPath;
		}

		// 单个文件快速 diff（ctrl+shift+d）
		if (quickAction === "diff" && selected.length === 1) {
			await openDiff(pi, ctx, selected[0], gitRoot);
			continue;
		}

		/**
		 * 条件说明：
		 * - viewChanges（查看 git 变更）: 文件有 git 变更状态（如 M/A/D），且处于 git 仓库中
		 * - fileDiff（进行 diff 对比）: 恰好选中 2 个文件，且都不是目录
		 */
		const allHaveChanges =
			Boolean(gitRoot) &&
			selected.every(
				(f) =>
					!f.isDirectory &&
					f.status !== undefined &&
					f.status !== "" &&
					f.status !== "??",
			);
		const canFileDiff =
			selected.length === 2 && selected.every((f) => !f.isDirectory);
		const allCanQuickLook =
			process.platform === "darwin" && selected.every((f) => !f.isDirectory);
		log.debug("action 可用性检查", {
			allHaveChanges,
			canFileDiff,
			allCanQuickLook,
			selectedCount: selected.length,
			gitRoot: !!gitRoot,
			selectedFiles: selected.map((f) => ({
				file: f.displayPath,
				isTracked: f.isTracked,
				isDir: f.isDirectory,
				status: f.status,
			})),
		});

		const allCanEdit = selected.every((f) => {
			const e = getEditableContent(f);
			return e.allowed;
		});

		const action = await showActionSelector(ctx, {
			canQuickLook: allCanQuickLook,
			canEdit: allCanEdit,
			canViewChanges: allHaveChanges,
			canFileDiff,
		});
		if (!action) {
			continue;
		}

		// 应用操作到所有选中的文件
		for (const file of selected) {
			switch (action) {
				case "quicklook":
					log.info("操作: quicklook", { 文件: file.displayPath });
					await quickLookPath(pi, ctx, file);
					break;
				case "open":
					log.info("操作: open", { 文件: file.displayPath });
					await openPath(pi, ctx, file);
					break;
				case "edit": {
					const ec = getEditableContent(file);
					if (!ec.allowed || ec.content === undefined) {
						log.warn("操作: edit 拒绝", {
							文件: file.displayPath,
							原因: ec.reason,
						});
						ctx.ui.notify(ec.reason ?? "File cannot be edited", "warning");
						break;
					}
					log.info("操作: edit", { 文件: file.displayPath });
					await editPath(ctx, file, ec.content);
					break;
				}
				case "addToPrompt":
					log.info("操作: addToPrompt", { 文件: file.displayPath });
					addFileToPrompt(ctx, file);
					break;
				case "viewChanges":
					log.info("操作: viewChanges", { 文件: file.displayPath });
					await openDiff(pi, ctx, file, gitRoot);
					break;
				case "fileDiff":
					// fileDiff 只有 2 个文件时出现，直接对两者对比
					if (selected.length === 2) {
						log.info("操作: fileDiff", {
							左: selected[0].displayPath,
							右: selected[1].displayPath,
						});
						await openFilesDiff(pi, ctx, selected[0], selected[1]);
						break;
					}
					break;
				default:
					log.info("操作: reveal", { 文件: file.displayPath });
					await revealPath(pi, ctx, file);
					break;
			}
		}
	}
};

const runDiffBrowser = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> => {
	if (!ctx.hasUI) {
		log.warn("/diff 被调用但当前不是交互模式");
		ctx.ui.notify("Diff requires interactive mode", "error");
		return;
	}

	log.info("/diff 命令启动");
	const { files, gitRoot } = await buildFileEntries(pi, ctx);
	log.debug("文件列表构建完成", { 文件数: files.length, 有Git仓库: !!gitRoot });

	if (files.length === 0) {
		ctx.ui.notify("No files found", "info");
		return;
	}

	let lastSelectedPath: string | null = null;
	while (true) {
		const { selected } = await showFileSelector(
			ctx,
			files,
			lastSelectedPath,
			gitRoot,
		);
		if (selected.length === 0) {
			log.info("/diff 用户取消选择");
			ctx.ui.notify("Diff cancelled", "info");
			return;
		}

		if (selected.length === 1) {
			lastSelectedPath = selected[0].canonicalPath;
		}

		const diffable = selected.filter(
			(f) => f.isTracked && !f.isDirectory && Boolean(gitRoot),
		);
		const nonDiffable = selected.filter(
			(f) => !(f.isTracked && !f.isDirectory && Boolean(gitRoot)),
		);

		if (diffable.length > 0) {
			log.info("/diff: 直接打开 diff", { 文件数: diffable.length });
			for (const file of diffable) {
				await openDiff(pi, ctx, file, gitRoot);
			}
			if (nonDiffable.length === 0) return;
		}

		// 不可 diff 的文件显示回退操作
		if (nonDiffable.length > 0) {
			for (const file of nonDiffable) {
				log.warn("/diff 跳过：文件不可 diff", {
					文件: file.displayPath,
					原因: file.isDirectory
						? "是目录"
						: !file.isTracked
							? "不是 tracked 文件"
							: "无 git 仓库",
				});
			}

			const anyCanQuickLook =
				process.platform === "darwin" &&
				nonDiffable.some((f) => !f.isDirectory);
			const anyCanEdit = nonDiffable.some((f) => getEditableContent(f).allowed);

			const action = await showActionSelector(ctx, {
				canQuickLook: anyCanQuickLook,
				canEdit: anyCanEdit,
				canViewChanges: false,
				canFileDiff: false,
			});
			if (!action) continue;

			for (const file of nonDiffable) {
				switch (action) {
					case "quicklook":
						log.info("/diff 回退操作: quicklook", { 文件: file.displayPath });
						await quickLookPath(pi, ctx, file);
						break;
					case "open":
						log.info("/diff 回退操作: open", { 文件: file.displayPath });
						await openPath(pi, ctx, file);
						break;
					case "edit": {
						const ec = getEditableContent(file);
						if (!ec.allowed || ec.content === undefined) {
							log.warn("/diff 回退操作: edit 拒绝", {
								文件: file.displayPath,
								原因: ec.reason,
							});
							ctx.ui.notify(ec.reason ?? "File cannot be edited", "warning");
							break;
						}
						log.info("/diff 回退操作: edit", { 文件: file.displayPath });
						await editPath(ctx, file, ec.content);
						break;
					}
					case "addToPrompt":
						log.info("/diff 回退操作: addToPrompt", { 文件: file.displayPath });
						addFileToPrompt(ctx, file);
						break;
					default:
						log.info("/diff 回退操作: reveal", { 文件: file.displayPath });
						await revealPath(pi, ctx, file);
						break;
				}
			}
		}
	}
};

export default function (pi: ExtensionAPI): void {
	log.info("files 扩展已加载");

	pi.registerCommand("files", {
		description:
			"浏览文件（含 git 状态和会话引用），支持 reveal/open/edit/diff/quicklook",
		handler: async (_args, ctx) => {
			log.info("命令 /files 被调用");
			await runFileBrowser(pi, ctx);
		},
	});

	pi.registerCommand("diff", {
		description:
			"打开文件选择器，选中 tracked 文件后直接打开 VS Code diff 视图",
		handler: async (_args, ctx) => {
			log.info("命令 /diff 被调用");
			await runDiffBrowser(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "浏览会话中引用的文件",
		handler: async (ctx) => {
			log.info("快捷键 ctrl+shift+o 触发：打开文件浏览器");
			await runFileBrowser(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+f", {
		description: "在 Finder 中显示最近引用的文件",
		handler: async (ctx) => {
			log.info("快捷键 ctrl+shift+f 触发：reveal 最新文件引用");
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				log.warn("ctrl+shift+f 未找到会话中的文件引用");
				ctx.ui.notify("No file reference found in the session", "warning");
				return;
			}

			const canonical = toCanonicalPath(latest.path);
			if (!canonical) {
				log.warn("ctrl+shift+f 引用的文件不存在", { 路径: latest.display });
				ctx.ui.notify(`File not found: ${latest.display}`, "error");
				return;
			}

			log.debug("ctrl+shift+f reveal 文件", { 路径: latest.display });
			await revealPath(pi, ctx, {
				canonicalPath: canonical.canonicalPath,
				resolvedPath: canonical.canonicalPath,
				displayPath: latest.display,
				exists: true,
				isDirectory: canonical.isDirectory,
				status: undefined,
				inRepo: false,
				isTracked: false,
				isReferenced: true,
				hasSessionChange: false,
				lastTimestamp: 0,
			});
		},
	});

	pi.registerShortcut("ctrl+shift+r", {
		description: "Quick Look 最近引用的文件",
		handler: async (ctx) => {
			log.info("快捷键 ctrl+shift+r 触发：Quick Look 最新文件引用");
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				log.warn("ctrl+shift+r 未找到会话中的文件引用");
				ctx.ui.notify("No file reference found in the session", "warning");
				return;
			}

			const canonical = toCanonicalPath(latest.path);
			if (!canonical) {
				log.warn("ctrl+shift+r 引用的文件不存在", { 路径: latest.display });
				ctx.ui.notify(`File not found: ${latest.display}`, "error");
				return;
			}

			log.debug("ctrl+shift+r Quick Look 文件", { 路径: latest.display });
			await quickLookPath(pi, ctx, {
				canonicalPath: canonical.canonicalPath,
				resolvedPath: canonical.canonicalPath,
				displayPath: latest.display,
				exists: true,
				isDirectory: canonical.isDirectory,
				status: undefined,
				inRepo: false,
				isTracked: false,
				isReferenced: true,
				hasSessionChange: false,
				lastTimestamp: 0,
			});
		},
	});
}
