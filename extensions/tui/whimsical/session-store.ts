/**
 * Session data persistence for whimsical extension.
 *
 * Persists two kinds of state:
 *   sessions.json           — final metrics for completed sessions (history)
 *   live/<sessionId>.json   — intermediate state for in-progress sessions
 *
 * The live state is written on every meaningful metric change and restored
 * on session_start, ensuring metrics survive /reload, pi -r, or any
 * extension re-initialization within the same session.
 */

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("whimsical:session-store");

export interface SessionRecord {
	/** Unique session ID from sessionManager.getSessionId() */
	sessionId: string;
	/** Unix timestamp (ms) when session ended */
	timestamp: number;
	/** Working directory */
	cwd: string;
	metrics: SessionMetrics;
}

export interface SessionMetrics {
	/** Number of thinking/reasoning blocks in this session */
	thinkingSteps: number;
	/** Average agent turns per user question (turn_end count / input count) */
	avgTurnsPerQuestion: number;
	/** Total user questions / inputs in this session */
	userQuestions: number;
	/** Number of distinct tool types used */
	toolTypesUsed: number;
}

/**
 * Raw serializable state used for mid-session live persistence.
 * Mirrors MetricsTracker's internal state (raw counts, not ratios).
 */
export interface LiveSessionState {
	sessionId: string;
	timestamp: number;
	cwd: string;
	thinkingSteps: number;
	userQuestions: number;
	agentTurns: number;
	toolTypes: string[];
}

export interface SessionStoreData {
	sessions: SessionRecord[];
}

const STORE_RELATIVE = join(".pi", "agent", "extensions-data", "whimsical");

function getStoreDir(): string {
	const home = homedir();
	return join(home, STORE_RELATIVE);
}

function getSessionsPath(): string {
	return join(getStoreDir(), "sessions.json");
}

function getLiveDir(): string {
	return join(getStoreDir(), "live");
}

function getLivePath(sessionId: string): string {
	return join(getLiveDir(), `${sessionId}.json`);
}

/**
 * Load all historical session records from disk.
 * Returns empty array if file doesn't exist or is corrupt.
 */
export async function loadSessions(): Promise<SessionRecord[]> {
	const p = getSessionsPath();
	try {
		const raw = await readFile(p, "utf-8");
		const parsed: SessionStoreData = JSON.parse(raw);
		if (Array.isArray(parsed?.sessions)) {
			return parsed.sessions;
		}
		log.warn("sessions.json has invalid format, returning empty");
		return [];
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		log.warn("Failed to load sessions.json", err);
		return [];
	}
}

/**
 * Load all sessions, but only the metric values for a given key.
 * Returns an array of numbers (the metric values from all historical sessions).
 */
export async function loadMetricHistory(
	key: keyof SessionMetrics,
): Promise<number[]> {
	const sessions = await loadSessions();
	return sessions.map((s) => s.metrics[key]);
}

/**
 * Append a session record to the store file.
 * Creates the directory and file if needed.
 */
export async function appendSession(record: SessionRecord): Promise<void> {
	const p = getSessionsPath();
	const existing = await loadSessions();
	existing.push(record);

	// Keep max 500 sessions to avoid unbounded growth
	const trimmed = existing.length > 500 ? existing.slice(-500) : existing;

	const data: SessionStoreData = { sessions: trimmed };

	try {
		await mkdir(getStoreDir(), { recursive: true });
		await writeFile(p, JSON.stringify(data, null, 2), "utf-8");
		log.debug("Appended session", record.sessionId);
	} catch (err) {
		log.error("Failed to persist session", err);
	}
}

// -------------------------------------------------------------------------
// Live state (per-session intermediate persistence across /reload etc.)
// -------------------------------------------------------------------------

/**
 * Persist the current in-progress tracker state for a session.
 * This ensures metrics survive extension re-initialization (/reload, pi -r).
 */
export async function saveLiveState(state: LiveSessionState): Promise<void> {
	const dir = getLiveDir();
	const p = getLivePath(state.sessionId);
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(p, JSON.stringify(state, null, 2), "utf-8");
	} catch (err) {
		log.error("Failed to save live state for %s", state.sessionId, err);
	}
}

/**
 * Load intermediate state for an in-progress session.
 * Returns null if no live state exists (fresh session, or already cleaned up).
 */
export async function loadLiveState(
	sessionId: string,
): Promise<LiveSessionState | null> {
	const p = getLivePath(sessionId);
	try {
		const raw = await readFile(p, "utf-8");
		return JSON.parse(raw) as LiveSessionState;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		log.warn("Failed to load live state for %s", sessionId, err);
		return null;
	}
}

/**
 * Delete the live state file for a completed session.
 * Called from session_shutdown after final metrics are persisted.
 */
export async function deleteLiveState(sessionId: string): Promise<void> {
	const p = getLivePath(sessionId);
	try {
		await unlink(p);
	} catch (err: unknown) {
		// ENOENT is fine — live file may not exist (e.g. fresh session
		// that didn't accumulate enough metrics to trigger a save).
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			log.warn("Failed to delete live state for %s", sessionId, err);
		}
	}
}
