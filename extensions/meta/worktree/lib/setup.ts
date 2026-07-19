/**
 * pi-worktree — Worktree 设置（symlink、setup 脚本、自动安装）
 */
import { existsSync, readFileSync, readdirSync, symlinkSync, openSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';
import type { SetupConfig } from '../types.js';
import { findHubRoot } from './git.js';

const log = createLogger('pi-worktree');

export const WORKTREES_DIR = '.worktrees';
export const SETUP_DIR = '.pi/worktree-setup';

function getSetupDir(repoPath: string): string {
	return join(findHubRoot(repoPath) || repoPath, SETUP_DIR);
}

function loadSetupConfig(repoPath: string): SetupConfig | null {
	const path = join(getSetupDir(repoPath), 'setup.json');
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as SetupConfig;
	} catch (e) {
		log.error('Invalid setup.json', { error: (e as Error).message });
		return null;
	}
}

function matchesPattern(entry: string, pattern: string): boolean {
	if (pattern.endsWith('*')) return entry.startsWith(pattern.slice(0, -1));
	return entry === pattern.replace(/\/$/, '');
}

function symlinkMatching(repoPath: string, targetDir: string, patterns: string[]): string[] {
	const linked: string[] = [];
	for (const entry of readdirSync(repoPath)) {
		if (!patterns.some((p) => matchesPattern(entry, p))) continue;
		const src = join(repoPath, entry);
		const dest = join(targetDir, entry);
		if (existsSync(dest)) continue;
		try {
			symlinkSync(src, dest);
			linked.push(entry);
		} catch (e) {
			log.error('Failed to symlink', { entry, error: (e as Error).message });
		}
	}
	return linked;
}

function autoInstall(repoPath: string, targetDir: string): void {
	if (
		existsSync(join(repoPath, 'package.json')) &&
		!existsSync(join(targetDir, 'node_modules'))
	) {
		const pm = existsSync(join(repoPath, 'pnpm-lock.yaml'))
			? 'pnpm'
			: existsSync(join(repoPath, 'yarn.lock'))
				? 'yarn'
				: 'npm';
		const child = spawn(pm, ['install'], { cwd: targetDir, stdio: 'ignore', detached: true });
		child.on('exit', (code) => {
			if (code !== 0) {
				log.error(`autoInstall failed: ${pm} install exited with code ${code}`, {
					targetDir,
				});
			}
		});
		child.unref();
	}
}

function setupLogPath(targetDir: string): string {
	const gitFile = join(targetDir, '.git');
	try {
		const content = readFileSync(gitFile, 'utf-8').trim();
		const match = content.match(/^gitdir:\s*(.+)$/);
		if (match) return join(match[1].trim(), 'pi-worktree-setup.log');
	} catch {
		/* ignore */
	}
	return join(targetDir, '.pi-worktree-setup.log');
}

function runSetupScript(
	scriptPath: string,
	repoPath: string,
	targetDir: string,
): { ok: boolean; output: string } {
	const result = spawnSync('bash', [scriptPath], {
		cwd: targetDir,
		encoding: 'utf-8',
		env: {
			...process.env,
			WT_REPO: targetDir,
			WT_MAIN: repoPath,
			WT_NAME: basename(targetDir),
			WT_REPO_NAME: basename(repoPath),
		},
	});
	if (result.error) return { ok: false, output: result.error.message };
	return {
		ok: result.status === 0,
		output: [result.stdout, result.stderr].filter(Boolean).join('').trim(),
	};
}

function runSetupScriptBackground(scriptPath: string, repoPath: string, targetDir: string): string {
	const logPath = setupLogPath(targetDir);
	const fd = openSync(logPath, 'w');
	spawn('bash', [scriptPath], {
		cwd: targetDir,
		stdio: ['ignore', fd, fd],
		detached: true,
		env: {
			...process.env,
			WT_REPO: targetDir,
			WT_MAIN: repoPath,
			WT_NAME: basename(targetDir),
			WT_REPO_NAME: basename(repoPath),
		},
	}).unref();
	closeSync(fd);
	return logPath;
}

export function runRepoSetup(repoPath: string, targetDir: string): string {
	const repoName = basename(repoPath);
	const config = loadSetupConfig(repoPath);
	const symlinkPatterns = config?.repos?.[repoName]?.symlink ??
		config?.defaultSymlink ?? ['.env*'];
	const linked = symlinkMatching(repoPath, targetDir, symlinkPatterns);
	const linkedNote = linked.length ? ` (linked ${linked.join(', ')})` : '';
	const background = config?.repos?.[repoName]?.background ?? config?.background ?? false;

	const scriptPath = join(getSetupDir(repoPath), `${repoName}.sh`);
	if (existsSync(scriptPath)) {
		if (background) {
			return `setup: ${repoName}.sh ⧖ background${linkedNote}\n  log: ${runSetupScriptBackground(scriptPath, repoPath, targetDir)}`;
		}
		const { ok, output } = runSetupScript(scriptPath, repoPath, targetDir);
		if (ok) return `setup: ${repoName}.sh ✓${linkedNote}`;
		return `setup: ${repoName}.sh ✗${output ? `\n${output.split('\n').slice(-6).join('\n')}` : ''}`;
	}

	autoInstall(repoPath, targetDir);
	return `setup: default${linkedNote}`;
}
