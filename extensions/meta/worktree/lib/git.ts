/**
 * pi-worktree — Git 辅助函数（单 repo 版）
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ── 基础 git ──

export function getCurrentBranch(repoPath: string): string {
	try {
		return execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoPath,
			encoding: 'utf-8',
		}).trim();
	} catch {
		return 'main';
	}
}

export function getDefaultBranch(repoPath: string): string | null {
	try {
		const ref = execSync('git symbolic-ref --quiet refs/remotes/origin/HEAD', {
			cwd: repoPath,
			encoding: 'utf-8',
		}).trim();
		return ref.replace(/^refs\/remotes\/origin\//, '') || null;
	} catch {
		for (const candidate of ['main', 'master']) {
			const check = spawnSync(
				'git',
				['show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`],
				{ cwd: repoPath, encoding: 'utf-8' },
			);
			if (check.status === 0) return candidate;
		}
		return null;
	}
}

// ── 状态采集 ──

/**
 * 计算工作区 dirty 文件数。
 */
export function getDirtyCount(repoPath: string): number {
	try {
		const out = execSync('git status --porcelain', {
			cwd: repoPath,
			encoding: 'utf-8',
		});
		return out.trim() ? out.trim().split('\n').length : 0;
	} catch {
		return 0;
	}
}

/**
 * 将 worktree 分支 rebase 到目标分支上。
 *
 * 使用 `git rebase <upstream> <branch>` 语法，无需 checkout 该分支
 * （避免与 worktree 的 checkout 冲突）。
 *
 * 流程：
 *   1. Fetch origin 获取最新 onto 分支
 *   2. git rebase origin/<ontoBranch> <sourceBranch>
 *   3. 失败时 abort 并恢复
 */
export function execRebase(
	repoRoot: string,
	sourceBranch: string,
	ontoBranch: string,
): { ok: boolean; message: string; conflicts: string[] } {
	const git = (args: string[]) =>
		spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });

	// 0. 清理遗留的悬空 rebase 状态（上一次 rebase 异常中断）
	const gitDir = join(repoRoot, '.git');
	if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
		const abort = git(['rebase', '--abort']);
		if (abort.status !== 0) {
			return {
				ok: false,
				message: `Dangling rebase state detected but abort failed: ${abort.stderr?.trim() || 'unknown error'}. Run 'git rebase --abort' manually first.`,
				conflicts: [],
			};
		}
	}

	// 1. Fetch origin 获取最新 onto 分支
	const hasRemote = git(['remote', 'get-url', 'origin']).status === 0;
	if (hasRemote) {
		const fetch = git(['fetch', 'origin', ontoBranch, '--quiet']);
		if (fetch.status !== 0) {
			return {
				ok: false,
				message: `Cannot fetch 'origin/${ontoBranch}': ${fetch.stderr?.trim() || 'unknown error'}`,
				conflicts: [],
			};
		}
	}

	// 2. 直接 rebase（无需 checkout，避免 worktree checkout 冲突）
	const ontoRef = hasRemote ? `origin/${ontoBranch}` : ontoBranch;
	const rebase = git(['rebase', ontoRef, sourceBranch]);

	if (rebase.status === 0) {
		return {
			ok: true,
			message: `Rebased '${sourceBranch}' onto '${ontoRef}'`,
			conflicts: [],
		};
	}

	// 失败：收集冲突文件
	const unmerged = (git(['diff', '--name-only', '--diff-filter=U']).stdout || '').trim();
	const conflictFiles = unmerged.split('\n').filter(Boolean);

	// 只有存在冲突文件时才需要 abort（rebase 进入了冲突状态）
	if (conflictFiles.length > 0) {
		const abort = git(['rebase', '--abort']);
		if (abort.status !== 0) {
			return {
				ok: false,
				message: `Rebase failed with conflicts; abort also failed: ${abort.stderr?.trim() || 'unknown error'}`,
				conflicts: conflictFiles,
			};
		}
		return {
			ok: false,
			message: `Rebase failed. ${conflictFiles.length} file(s) conflict. Rebase aborted.`,
			conflicts: conflictFiles,
		};
	}

	// 非冲突失败（rebase 根本没启动或前置检查失败）
	const stderr = rebase.stderr?.trim() || 'unknown error';
	return {
		ok: false,
		message: `Rebase failed: ${stderr.split('\n').pop() || stderr}`,
		conflicts: [],
	};
}

/**
 * 分支与 origin/base 的 ahead/behind 数。
 */
export function getAheadBehind(
	repoPath: string,
	branch: string,
	remote?: string,
): { ahead: number; behind: number } {
	try {
		const ref = remote ? `${remote}/${branch}` : `origin/${branch}`;
		const out = execSync(`git rev-list --left-right --count ${ref}...HEAD`, {
			cwd: repoPath,
			encoding: 'utf-8',
		}).trim();
		const parts = out.split('\t');
		return {
			behind: parseInt(parts[0] || '0', 10),
			ahead: parseInt(parts[1] || '0', 10),
		};
	} catch {
		return { ahead: 0, behind: 0 };
	}
}
