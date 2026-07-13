/**
 * Files Extension — Shared Types
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// ── File References ─────────────────────────────────────────────────────────

export type FileReference = {
	path: string;
	display: string;
	exists: boolean;
	isDirectory: boolean;
};

// ── File Entries (combined display model) ──────────────────────────────────

export type FileEntry = {
	canonicalPath: string;
	resolvedPath: string;
	displayPath: string;
	exists: boolean;
	isDirectory: boolean;
	status?: string;
	gitRoot?: string;
	inRepo: boolean;
	isTracked: boolean;
	isReferenced: boolean;
	hasSessionChange: boolean;
	lastTimestamp: number;
};

export type GitStatusEntry = {
	status: string;
	exists: boolean;
	isDirectory: boolean;
};

// ── Change Recording ───────────────────────────────────────────────────────

export type ChangeSource = "write" | "edit" | "bash_result" | "output_detected";

export interface ChangeRecord {
	path: string;
	display: string;
	source: ChangeSource;
	timestamp: number;
	count: number;
}

// ── Session File Changes ───────────────────────────────────────────────────

export type FileToolName = "write" | "edit";

export type SessionFileChange = {
	operations: Set<FileToolName>;
	lastTimestamp: number;
};

// ── Tool Results ───────────────────────────────────────────────────────────

export type ContentBlock = {
	type?: string;
	text?: string;
	arguments?: Record<string, unknown>;
};

// ── Edit Checks ────────────────────────────────────────────────────────────

export type EditCheckResult = {
	allowed: boolean;
	reason?: string;
	content?: string;
};

// ── Diff Tool ──────────────────────────────────────────────────────────────

export type DiffToolCommand = {
	cmd: string;
	args: (left: string, right: string) => string[];
} | null;
