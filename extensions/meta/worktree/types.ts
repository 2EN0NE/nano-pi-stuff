/**
 * pi-worktree — 共享类型定义
 */

// ── Setup 配置 ──
export interface SetupConfig {
	defaultSymlink?: string[];
	background?: boolean;
	repos?: Record<string, { symlink?: string[]; background?: boolean }>;
}

// ── 状态持久化 ──
export interface WorktreeState {
	mode: boolean;
	active: string | null;
	paths: Record<string, string>;
	widgetHidden?: boolean;
}

// ── Worktree 信息 ──
export interface WorktreeInfo {
	name: string;
	branch: string;
	path?: string;
}

// ── 操作结果 ──
export interface OpResult {
	ok: boolean;
	message: string;
	path?: string;
}
