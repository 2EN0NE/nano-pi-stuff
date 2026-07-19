/**
 * pi-worktree — 核心 worktree 操作（创建/删除/查询/命名）
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import type { OpResult, WorktreeInfo } from '../types';
import {
	getDefaultBranch,
	fetchBase,
	getCurrentBranch,
	ensureGitignore,
	isBranchMergedIntoBase,
} from './git';
import { runRepoSetup } from './setup.js';
import { getNamePool, constellationOf } from '../stars';

export { WORKTREES_DIR } from './setup.js';

// ── 名称分配 ──

export function getExistingNames(repoPath: string): Set<string> {
	const existing = new Set<string>();
	const dir = join(repoPath, '.worktrees');
	if (existsSync(dir)) {
		for (const entry of readdirSync(dir)) {
			if (statSync(join(dir, entry)).isDirectory()) existing.add(entry);
		}
	}
	return existing;
}

export function pickAvailableName(repoPath: string): string {
	const existing = getExistingNames(repoPath);
	const pool = getNamePool();
	const available = pool.filter((n) => !existing.has(n));
	if (available.length > 0) return available[Math.floor(Math.random() * available.length)];
	// 池用尽：{最后用过的星座}-minor~N 后备
	const lastCons = [...existing].map((n) => constellationOf(n)).filter(Boolean) as string[];
	const cons = lastCons.length > 0 ? lastCons[lastCons.length - 1] : 'Zodiac';
	return `${cons}-minor~${existing.size + 1}`;
}

// ── 创建 worktree ──

export function createWorktree(repoPath: string, name: string, branch?: string): OpResult {
	const targetDir = join(repoPath, '.worktrees', name);
	if (existsSync(targetDir))
		return { ok: false, message: `Worktree '${name}' already exists in ${basename(repoPath)}` };

	ensureGitignore(repoPath, '.worktrees');

	const newBranch = branch || `wt/${name}`;
	const defaultBranch = getDefaultBranch(repoPath);
	const startPoint =
		defaultBranch && fetchBase(repoPath, defaultBranch) ? `origin/${defaultBranch}` : null;
	const addArgs = startPoint
		? ['worktree', 'add', '-b', newBranch, targetDir, startPoint]
		: ['worktree', 'add', '-b', newBranch, targetDir];
	const result = spawnSync('git', addArgs, { cwd: repoPath, encoding: 'utf-8' });

	if (result.status !== 0) {
		const err = result.stderr?.trim() || 'Unknown error';
		if (err.includes('already exists')) {
			const r2 = spawnSync(
				'git',
				['worktree', 'add', targetDir, branch || getCurrentBranch(repoPath)],
				{ cwd: repoPath, encoding: 'utf-8' },
			);
			if (r2.status !== 0) return { ok: false, message: `Failed: ${r2.stderr?.trim()}` };
			return {
				ok: true,
				message: `Created worktree '${name}' in ${basename(repoPath)} (existing branch)\n  ${runRepoSetup(repoPath, targetDir)}`,
				path: targetDir,
			};
		}
		return { ok: false, message: `Failed: ${err}` };
	}

	const setup = runRepoSetup(repoPath, targetDir);
	return {
		ok: true,
		message: `Created worktree '${name}' in ${basename(repoPath)} → branch ${newBranch}${startPoint ? ` (from ${startPoint})` : ''}\n  ${setup}`,
		path: targetDir,
	};
}

// ── 删除 worktree ──

export function removeWorktree(repoPath: string, name: string, force?: boolean): OpResult {
	const targetDir = join(repoPath, '.worktrees', name);
	if (!existsSync(targetDir))
		return { ok: false, message: `Worktree '${name}' not found in ${basename(repoPath)}` };

	// 先尝试安全删除（无 --force），避免绕过 git 安全检查
	const args = force
		? ['worktree', 'remove', targetDir, '--force']
		: ['worktree', 'remove', targetDir];
	const result = spawnSync('git', args, {
		cwd: repoPath,
		encoding: 'utf-8',
	});
	if (result.status !== 0) {
		const msg = result.stderr?.trim() || 'unknown error';
		return { ok: false, message: `Failed: ${msg}` };
	}
	return { ok: true, message: `Removed worktree '${name}' from ${basename(repoPath)}` };
}

export function deleteWorktreeBranch(
	repoPath: string,
	name: string,
	remoteRemote?: string,
): string[] {
	const msgs: string[] = [];
	const branch = `wt/${name}`;
	const localDel = spawnSync('git', ['branch', '-D', branch], {
		cwd: repoPath,
		encoding: 'utf-8',
	});
	if (localDel.status === 0) msgs.push(`Deleted local branch '${branch}'`);
	if (remoteRemote) {
		const remoteDel = spawnSync('git', ['push', remoteRemote, '--delete', branch], {
			cwd: repoPath,
			encoding: 'utf-8',
		});
		if (remoteDel.status === 0) msgs.push(`Deleted remote branch '${remoteRemote}/${branch}'`);
	}
	return msgs;
}

// ── 查询 worktree ──

export function getExistingWorktrees(repoPath: string): WorktreeInfo[] {
	const dir = join(repoPath, '.worktrees');
	if (!existsSync(dir)) return [];

	const entries: WorktreeInfo[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (!statSync(full).isDirectory() || !existsSync(join(full, '.git'))) continue;
		let branch = 'unknown';
		try {
			branch = execSync('git rev-parse --abbrev-ref HEAD', {
				cwd: full,
				encoding: 'utf-8',
			}).trim();
		} catch {
			/* ignore */
		}
		entries.push({ name: entry, branch, path: full });
	}
	return entries;
}

export function findMergedWorktrees(
	repoPath: string,
	exclude: Set<string>,
): Array<{ name: string; branch: string }> {
	return getExistingWorktrees(repoPath)
		.filter((wt) => !exclude.has(wt.name) && wt.branch !== 'unknown')
		.filter((wt) => isBranchMergedIntoBase(repoPath, wt.branch))
		.map((wt) => ({ name: wt.name, branch: wt.branch }));
}
