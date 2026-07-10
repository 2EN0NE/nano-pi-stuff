/**
 * Session data persistence for whimsical extension.
 *
 * Reads/writes session metrics to:
 *   ~/.pi/agent/extensions-data/whimsical/sessions.json
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export interface SessionStoreData {
	sessions: SessionRecord[];
}

const STORE_RELATIVE = join(
	".pi",
	"agent",
	"extensions-data",
	"whimsical",
	"sessions.json",
);

function getStorePath(): string {
	const home = homedir();
	return join(home, STORE_RELATIVE);
}

/**
 * Load all historical session records from disk.
 * Returns empty array if file doesn't exist or is corrupt.
 */
export async function loadSessions(): Promise<SessionRecord[]> {
	const p = getStorePath();
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
	const p = getStorePath();
	const existing = await loadSessions();
	existing.push(record);

	// Keep max 500 sessions to avoid unbounded growth
	const trimmed = existing.length > 500 ? existing.slice(-500) : existing;

	const data: SessionStoreData = { sessions: trimmed };

	try {
		await mkdir(
			join(homedir(), ".pi", "agent", "extensions-data", "whimsical"),
			{
				recursive: true,
			},
		);
		await writeFile(p, JSON.stringify(data, null, 2), "utf-8");
		log.debug("Appended session", record.sessionId);
	} catch (err) {
		log.error("Failed to persist session", err);
	}
}
