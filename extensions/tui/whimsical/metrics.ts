/**
 * Metrics tracker for the current session.
 *
 * Tracks 4 dimensions in real time as events come in.
 * Provides a snapshot to compute sigma against historical data.
 * Uses clamping for display only — persistence stores raw values.
 *
 * Supports serialization: exportRawState() / importRawState() for
 * mid-session persistence across extension reloads (/reload, pi -r).
 */

import type { SessionMetrics } from './session-store.js';

export interface MetricsSnapshot {
	thinkingSteps: number;
	avgTurnsPerQuestion: number;
	userQuestions: number;
	toolTypesUsed: number;
}

/**
 * Serializable raw state of the tracker — used for per-session live persistence.
 */
export interface TrackerRawState {
	thinkingSteps: number;
	userQuestions: number;
	agentTurns: number;
	toolTypes: string[];
}

export class MetricsTracker {
	private _thinkingSteps = 0;
	private _userQuestions = 0;
	private _agentTurns = 0;
	private _toolTypes = new Set<string>();

	/** Record a thinking/reasoning block start */
	incrementThinkingSteps(): void {
		this._thinkingSteps++;
	}

	/** Record a user input/question */
	incrementUserQuestions(): void {
		this._userQuestions++;
	}

	/** Record an agent turn completion */
	incrementAgentTurns(): void {
		this._agentTurns++;
	}

	/** Record a tool execution by type */
	recordToolType(toolName: string): void {
		this._toolTypes.add(toolName);
	}

	/** Raw (unclamped) snapshot — truth for both display and persistence */
	private _rawSnapshot(): MetricsSnapshot {
		return {
			thinkingSteps: this._thinkingSteps,
			avgTurnsPerQuestion:
				this._userQuestions > 0 ? this._agentTurns / this._userQuestions : 0,
			userQuestions: this._userQuestions,
			toolTypesUsed: this._toolTypes.size,
		};
	}

	/**
	 * Get snapshot for live display (turn_start / tick).
	 *
	 * Clamps avgTurnsPerQuestion to at least 1 at the first turn_start
	 * (before any turn_end has fired) to avoid a misleading z-score of 0
	 * when compared against a historical mean of 2-5.
	 */
	snapshot(): MetricsSnapshot {
		const raw = this._rawSnapshot();
		if (raw.avgTurnsPerQuestion <= 0 && raw.userQuestions > 0) {
			return { ...raw, avgTurnsPerQuestion: 1 / raw.userQuestions };
		}
		return raw;
	}

	/**
	 * Get final metrics for persistence (no clamping — preserves real values).
	 * This ensures abnormal shutdowns (abort before first turn_end) don't
	 * inflate the historical mean with a Math.max(1,0) artifact.
	 */
	toSessionMetrics(): SessionMetrics {
		return this._rawSnapshot();
	}

	/**
	 * Export raw mutable state for persistence.
	 * Returns a plain object suitable for JSON serialization.
	 */
	exportRawState(): TrackerRawState {
		return {
			thinkingSteps: this._thinkingSteps,
			userQuestions: this._userQuestions,
			agentTurns: this._agentTurns,
			toolTypes: [...this._toolTypes],
		};
	}

	/**
	 * Import raw state previously exported via exportRawState().
	 * Restores all counters and tool type set from a previous incarnation.
	 */
	importRawState(state: TrackerRawState): void {
		this._thinkingSteps = state.thinkingSteps;
		this._userQuestions = state.userQuestions;
		this._agentTurns = state.agentTurns;
		this._toolTypes = new Set(state.toolTypes);
	}

	/** Reset all counters (for a new session) */
	reset(): void {
		this._thinkingSteps = 0;
		this._userQuestions = 0;
		this._agentTurns = 0;
		this._toolTypes.clear();
	}
}
