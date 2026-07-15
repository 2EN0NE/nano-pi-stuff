/**
 * Files Extension — File Scanner (扫描器)
 *
 * 构建完整的文件列表，合并多个数据源：
 * - git 仓库中的 tracked/untracked 文件
 * - git status 变更状态
 * - 会话引用（来自 session entries）
 * - 会话变更（write/edit 工具调用）
 * - recorder 实时跟踪的变更
 */

import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import type {
	FileEntry,
	FileReference,
	FileToolName,
	SessionFileChange,
	ContentBlock,
} from './types.js';
import {
	findGitRootForFile,
	getAllGitRoots,
	getGitFiles,
	getGitStatusMap,
	toCanonicalPath,
} from './git.js';
import { getChangePaths } from './recorder.js';

const log = createLogger('files:scanner');

// ── File Reference Extraction ──────────────────────────────────────────────

const FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
const FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

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
	if (!args || typeof args !== 'object') {
		return [];
	}

	const refs: string[] = [];
	const record = args as Record<string, unknown>;
	const directKeys = ['path', 'file', 'filePath', 'filepath', 'fileName', 'filename'] as const;
	const listKeys = ['paths', 'files', 'filePaths'] as const;

	for (const key of directKeys) {
		const value = record[key];
		if (typeof value === 'string') {
			refs.push(value);
		}
	}

	for (const key of listKeys) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === 'string') {
					refs.push(item);
				}
			}
		}
	}

	return refs;
};

const extractFileReferencesFromContent = (content: unknown): string[] => {
	if (typeof content === 'string') {
		return extractFileReferencesFromText(content);
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const refs: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== 'object') {
			continue;
		}

		const block = part as ContentBlock;

		if (block.type === 'text' && typeof block.text === 'string') {
			refs.push(...extractFileReferencesFromText(block.text));
		}

		if (block.type === 'toolCall') {
			refs.push(...extractPathsFromToolArgs(block.arguments));
		}
	}

	return refs;
};

const extractFileReferencesFromEntry = (entry: SessionEntry): string[] => {
	if (entry.type === 'message') {
		return 'content' in entry.message
			? extractFileReferencesFromContent(entry.message.content)
			: [];
	}

	if (entry.type === 'custom_message') {
		return extractFileReferencesFromContent(entry.content);
	}

	return [];
};

// ── Reference Normalization ────────────────────────────────────────────────

const sanitizeReference = (raw: string): string => {
	let value = raw.trim();
	value = value.replace(/^[""'`(<\[]+/, '');
	value = value.replace(/[>"'`,;).\]]+$/, '');
	value = value.replace(/[.,;:]+$/, '');
	return value;
};

const isCommentLikeReference = (value: string): boolean => value.startsWith('//');

const stripLineSuffix = (value: string): string => {
	let result = value.replace(/#L\d+(C\d+)?$/i, '');
	const lastSeparator = Math.max(result.lastIndexOf('/'), result.lastIndexOf('\\'));
	const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
	const segment = result.slice(segmentStart);
	const colonIndex = segment.indexOf(':');
	if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? '')) {
		result = result.slice(0, segmentStart + colonIndex);
		return result;
	}

	const lastColon = result.lastIndexOf(':');
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

	if (candidate.startsWith('file://')) {
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

	if (candidate.startsWith('~')) {
		candidate = path.join(os.homedir(), candidate.slice(1));
	}

	if (!path.isAbsolute(candidate)) {
		candidate = path.resolve(cwd, candidate);
	}

	candidate = path.normalize(candidate);
	const root = path.parse(candidate).root;
	if (candidate.length > root.length) {
		candidate = candidate.replace(/[\\/]+$/, '');
	}

	return candidate;
};

// ── Display Path Formatting ────────────────────────────────────────────────

const formatDisplayPath = (absolutePath: string, cwd: string, gitRoot?: string): string => {
	if (gitRoot) {
		const normalizedGitRoot = path.resolve(gitRoot);
		const normalizedCwd = path.resolve(cwd);
		if (
			normalizedGitRoot !== normalizedCwd &&
			absolutePath.startsWith(normalizedGitRoot + path.sep)
		) {
			const repoName = path.relative(normalizedCwd, normalizedGitRoot);
			return path.join(repoName, path.relative(normalizedGitRoot, absolutePath));
		}
	}

	const normalizedCwd = path.resolve(cwd);
	if (absolutePath.startsWith(normalizedCwd + path.sep)) {
		return path.relative(normalizedCwd, absolutePath);
	}

	return absolutePath;
};

// ── Collectors ─────────────────────────────────────────────────────────────

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

export const findLatestFileReference = (
	entries: SessionEntry[],
	cwd: string,
): FileReference | null => {
	const refs = collectRecentFileReferences(entries, cwd, 100);
	return refs.find((ref) => ref.exists) ?? null;
};

const collectSessionFileChanges = (
	entries: SessionEntry[],
	cwd: string,
): Map<string, SessionFileChange> => {
	const toolCalls = new Map<string, { path: string; name: FileToolName }>();

	for (const entry of entries) {
		if (entry.type !== 'message') continue;
		const msg = entry.message;

		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'toolCall') {
					const name = block.name as FileToolName;
					if (name === 'write' || name === 'edit') {
						const filePath = block.arguments?.path;
						if (filePath && typeof filePath === 'string') {
							toolCalls.set(block.id, { path: filePath, name });
						}
					}
				}
			}
		}
	}

	const fileMap = new Map<string, SessionFileChange>();

	for (const entry of entries) {
		if (entry.type !== 'message') continue;
		const msg = entry.message;

		if (msg.role === 'toolResult') {
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

// ── File Entry Builder ─────────────────────────────────────────────────────

export const buildFileEntries = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<{ files: FileEntry[]; gitRoots: string[] }> => {
	const entries = ctx.sessionManager.getBranch();
	const sessionChanges = collectSessionFileChanges(entries, ctx.cwd);
	const gitRoots = await getAllGitRoots(pi, ctx.cwd);

	const fileMap = new Map<string, FileEntry>();

	const upsertFile = (
		data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean },
	) => {
		const existing = fileMap.get(data.canonicalPath);
		const dp = data.displayPath ?? formatDisplayPath(data.canonicalPath, ctx.cwd, data.gitRoot);

		if (existing) {
			fileMap.set(data.canonicalPath, {
				...existing,
				...data,
				displayPath: dp,
				exists: data.exists ?? existing.exists,
				isDirectory: data.isDirectory ?? existing.isDirectory,
				isReferenced: existing.isReferenced || data.isReferenced === true,
				gitRoot: existing.gitRoot ?? data.gitRoot,
				inRepo: existing.inRepo || data.inRepo === true,
				isTracked: existing.isTracked || data.isTracked === true,
				hasSessionChange: existing.hasSessionChange || data.hasSessionChange === true,
				lastTimestamp: Math.max(existing.lastTimestamp, data.lastTimestamp ?? 0),
			});
			return;
		}

		fileMap.set(data.canonicalPath, {
			canonicalPath: data.canonicalPath,
			resolvedPath: data.resolvedPath ?? data.canonicalPath,
			displayPath: dp,
			exists: data.exists ?? true,
			isDirectory: data.isDirectory,
			status: data.status,
			gitRoot: data.gitRoot,
			inRepo: data.inRepo ?? false,
			isTracked: data.isTracked ?? false,
			isReferenced: data.isReferenced ?? false,
			hasSessionChange: data.hasSessionChange ?? false,
			lastTimestamp: data.lastTimestamp ?? 0,
		});
	};

	for (const gitRoot of gitRoots) {
		const [statusMap, { tracked, files: gitFiles }] = await Promise.all([
			getGitStatusMap(pi, gitRoot),
			getGitFiles(pi, gitRoot),
		]);

		for (const file of gitFiles) {
			upsertFile({
				canonicalPath: file.canonicalPath,
				resolvedPath: file.canonicalPath,
				isDirectory: file.isDirectory,
				exists: true,
				status: statusMap.get(file.canonicalPath)?.status,
				gitRoot,
				inRepo: true,
				isTracked: tracked.has(file.canonicalPath),
			});
		}

		for (const [canonicalPath, statusEntry] of statusMap.entries()) {
			if (fileMap.has(canonicalPath)) continue;
			upsertFile({
				canonicalPath,
				resolvedPath: canonicalPath,
				isDirectory: statusEntry.isDirectory,
				exists: statusEntry.exists,
				status: statusEntry.status,
				gitRoot,
				inRepo: true,
				isTracked: tracked.has(canonicalPath) || statusEntry.status !== '??',
			});
		}
	}

	// 会话引用
	const references = collectRecentFileReferences(entries, ctx.cwd, 200).filter(
		(ref) => ref.exists,
	);
	for (const ref of references) {
		const canonical = toCanonicalPath(ref.path);
		if (!canonical) continue;
		const gitRoot = findGitRootForFile(canonical.canonicalPath, gitRoots);
		upsertFile({
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			isDirectory: canonical.isDirectory,
			exists: true,
			gitRoot,
			inRepo: !!gitRoot,
			isReferenced: true,
		});
	}

	// 会话变更（write/edit 工具调用）
	for (const [canonicalPath, change] of sessionChanges.entries()) {
		const canonical = toCanonicalPath(canonicalPath);
		if (!canonical) continue;
		const gitRoot = findGitRootForFile(canonical.canonicalPath, gitRoots);
		upsertFile({
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			isDirectory: canonical.isDirectory,
			exists: true,
			gitRoot,
			inRepo: !!gitRoot,
			hasSessionChange: true,
			lastTimestamp: change.lastTimestamp,
		});
	}

	// recorder 跟踪的变更（含工程外路径）
	for (const changePath of getChangePaths()) {
		if (fileMap.has(changePath)) continue;
		const isDir = existsSync(changePath) && statSync(changePath).isDirectory();
		const gitRoot = findGitRootForFile(changePath, gitRoots);
		upsertFile({
			canonicalPath: changePath,
			resolvedPath: changePath,
			isDirectory: isDir,
			exists: existsSync(changePath),
			gitRoot,
			inRepo: !!gitRoot,
			hasSessionChange: true,
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

	return { files, gitRoots };
};
