/**
 * Files Extension — Git Operations
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import type { GitStatusEntry } from './types.js';

const log = createLogger('files:git');

// ── Helpers ────────────────────────────────────────────────────────────────

export const splitNullSeparated = (value: string): string[] => value.split('\0').filter(Boolean);

// ── Git Root Discovery ─────────────────────────────────────────────────────

export const getAllGitRoots = async (pi: ExtensionAPI, cwd: string): Promise<string[]> => {
	const result = await pi.exec('find', [cwd, '-maxdepth', '2', '-name', '.git', '-type', 'd']);
	if (result.code !== 0 || !result.stdout.trim()) {
		return [];
	}

	const dirs = result.stdout.trim().split('\n').filter(Boolean);
	const roots = dirs.map((p) => path.resolve(path.dirname(p))).filter((r) => existsSync(r));
	return [...new Set(roots)];
};

export const findGitRootForFile = (
	canonicalPath: string,
	gitRoots: string[],
): string | undefined => {
	for (const root of gitRoots) {
		if (
			!path.relative(root, canonicalPath).startsWith('..') &&
			!path.isAbsolute(path.relative(root, canonicalPath))
		) {
			return root;
		}
	}
	return undefined;
};

export const resolveGitRoot = async (pi: ExtensionAPI, cwd: string): Promise<string | null> => {
	const result = await pi.exec('git', ['rev-parse', '--show-toplevel'], {
		cwd,
	});
	if (result.code !== 0 || !result.stdout.trim()) return null;
	return result.stdout.trim();
};

// ── Git Status & File Listing ──────────────────────────────────────────────

export const getGitStatusMap = async (
	pi: ExtensionAPI,
	cwd: string,
): Promise<Map<string, GitStatusEntry>> => {
	const statusMap = new Map<string, GitStatusEntry>();
	const result = await pi.exec('git', ['status', '--porcelain=1', '-z'], {
		cwd,
	});
	if (result.code !== 0 || !result.stdout) {
		return statusMap;
	}

	const entries = splitNullSeparated(result.stdout);
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		if (!entry || entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const statusLabel = status.replace(/\s/g, '') || status.trim();
		let filePath = entry.slice(3);
		if ((status.startsWith('R') || status.startsWith('C')) && entries[i + 1]) {
			filePath = entries[i + 1];
			i += 1;
		}
		if (!filePath) continue;

		const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
		statusMap.set(filePath, {
			status: statusLabel,
			exists: true,
			isDirectory: false,
		});
	}

	return statusMap;
};

export const getGitFiles = async (
	pi: ExtensionAPI,
	gitRoot: string,
): Promise<{
	tracked: Set<string>;
	files: Array<{ canonicalPath: string; isDirectory: boolean }>;
}> => {
	const tracked = new Set<string>();
	const files: Array<{ canonicalPath: string; isDirectory: boolean }> = [];

	const trackedResult = await pi.exec('git', ['ls-files', '-z'], {
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
		'git',
		['ls-files', '-z', '--others', '--exclude-standard'],
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

export const takeGitSnapshot = async (
	pi: ExtensionAPI,
	root: string,
): Promise<Map<string, string>> => {
	const map = new Map<string, string>();
	const result = await pi.exec('git', ['status', '--porcelain=1', '-z'], {
		cwd: root,
	});
	if (result.code !== 0 || !result.stdout) return map;

	const entries = splitNullSeparated(result.stdout);
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry || entry.length < 4) continue;
		const statusLabel = entry.slice(0, 2).replace(/\s/g, '') || entry.slice(0, 2).trim();
		let filePath = entry.slice(3);
		if ((entry.startsWith('R') || entry.startsWith('C')) && entries[i + 1]) {
			filePath = entries[i + 1];
			i++;
		}
		map.set(filePath, statusLabel);
	}
	return map;
};

// ── Canonical Path Resolution ──────────────────────────────────────────────

export const toCanonicalPath = (
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

export const toCanonicalPathMaybeMissing = (
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
