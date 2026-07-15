import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type Complexity = 'trivial' | 'simple' | 'medium' | 'complex';

export interface ModelRef {
	provider: string;
	model: string;
}

/** A named profile: maps each functional role to a model */
export interface ModelProfile {
	classifier: ModelRef;
	routing: Record<Complexity, ModelRef>;
	largeContext: {
		thresholdTokens: number;
		model: ModelRef;
	};
}

export interface SmartContextConfig {
	/** Active profile name (defaults to "balanced") */
	activeProfile?: string;
	/** Named profiles keyed by name */
	profiles?: Record<string, ModelProfile>;

	// ── Legacy flat config (backward compatible) ──
	classifier?: ModelRef;
	routing?: Partial<Record<Complexity, ModelRef>>;
	largeContext?: {
		thresholdTokens?: number;
		model?: ModelRef;
	};
}

// ── Built-in profiles ──────────────────────────────────────────────

const DEEPSEEK_FLASH: ModelRef = {
	provider: 'deepseek',
	model: 'deepseek-v4-flash',
};
const DEEPSEEK_PRO: ModelRef = {
	provider: 'deepseek',
	model: 'deepseek-v4-pro',
};

const BUILTIN_PROFILES: Record<string, ModelProfile> = {
	/** 平衡模式（默认）：分类用 flash，复杂任务用 pro */
	balanced: {
		classifier: DEEPSEEK_FLASH,
		routing: {
			trivial: DEEPSEEK_FLASH,
			simple: DEEPSEEK_PRO,
			medium: DEEPSEEK_PRO,
			complex: DEEPSEEK_PRO,
		},
		largeContext: {
			thresholdTokens: 500_000,
			model: DEEPSEEK_PRO,
		},
	},

	/** 快速模式：全部用 flash，适合简单/快速迭代场景 */
	fast: {
		classifier: DEEPSEEK_FLASH,
		routing: {
			trivial: DEEPSEEK_FLASH,
			simple: DEEPSEEK_FLASH,
			medium: DEEPSEEK_FLASH,
			complex: DEEPSEEK_FLASH,
		},
		largeContext: {
			thresholdTokens: 500_000,
			model: DEEPSEEK_FLASH,
		},
	},

	/** 高质量模式：全部用 pro，适合关键/复杂任务 */
	quality: {
		classifier: DEEPSEEK_FLASH,
		routing: {
			trivial: DEEPSEEK_PRO,
			simple: DEEPSEEK_PRO,
			medium: DEEPSEEK_PRO,
			complex: DEEPSEEK_PRO,
		},
		largeContext: {
			thresholdTokens: 500_000,
			model: DEEPSEEK_PRO,
		},
	},
};

/** Default profile to use when nothing is configured */
const DEFAULT_PROFILE_NAME = 'balanced';

const CONFIG_FILE = 'smart-context.json';

// ── Helpers ────────────────────────────────────────────────────────

function findProjectRoot(cwd: string): string | null {
	let dir = cwd;
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, '.pi')) || existsSync(join(dir, '.git'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

function configPath(cwd: string): string | null {
	const root = findProjectRoot(cwd);
	if (!root) return null;
	return join(root, '.pi', CONFIG_FILE);
}

function mergeRef(base: ModelRef, override?: Partial<ModelRef>): ModelRef {
	if (!override) return base;
	return {
		provider: override.provider ?? base.provider,
		model: override.model ?? base.model,
	};
}

/** Merge a partial flat config snippet onto a base profile */
function mergeIntoProfile(base: ModelProfile, raw: Record<string, unknown>): ModelProfile {
	const rawClassifier = raw.classifier as Partial<ModelRef> | undefined;
	const rawRouting = raw.routing as Partial<Record<Complexity, Partial<ModelRef>>> | undefined;
	const rawLarge = raw.largeContext as
		{ thresholdTokens?: number; model?: Partial<ModelRef> } | undefined;

	const threshold = rawLarge?.thresholdTokens;

	return {
		classifier: mergeRef(base.classifier, rawClassifier),
		routing: {
			trivial: mergeRef(base.routing.trivial, rawRouting?.trivial),
			simple: mergeRef(base.routing.simple, rawRouting?.simple),
			medium: mergeRef(base.routing.medium, rawRouting?.medium),
			complex: mergeRef(base.routing.complex, rawRouting?.complex),
		},
		largeContext: {
			thresholdTokens:
				typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0
					? threshold
					: base.largeContext.thresholdTokens,
			model: mergeRef(base.largeContext.model, rawLarge?.model),
		},
	};
}

// ── Config loader ──────────────────────────────────────────────────

let cachedRaw: { raw: Record<string, unknown> } | null = null;
let cachedKey: string | null = null;

function loadConfigRaw(cwd: string): { raw: Record<string, unknown> } {
	const path = configPath(cwd);
	const key = path ?? cwd;
	if (cachedRaw && cachedKey === key) {
		return cachedRaw;
	}

	let raw: Record<string, unknown> = {};
	if (path && existsSync(path)) {
		try {
			raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
		} catch {
			raw = {};
		}
	}

	cachedRaw = { raw };
	cachedKey = key;
	return cachedRaw;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Resolve the effective ModelProfile from config.
 *
 * Resolution priority:
 * 1. If `smart-context.json` has `profiles` + `activeProfile` → use that profile
 * 2. If legacy flat fields (classifier/routing/largeContext) exist → merge onto default profile
 * 3. Otherwise → return the default (balanced) profile
 */
export function resolveProfile(cwd: string = process.cwd()): ModelProfile {
	const { raw } = loadConfigRaw(cwd);

	// ── Profile mode ────────────────────────────────────────────────
	if (raw.profiles && typeof raw.profiles === 'object') {
		const profileName =
			typeof raw.activeProfile === 'string' && raw.activeProfile
				? raw.activeProfile
				: DEFAULT_PROFILE_NAME;

		const userProfiles = raw.profiles as Record<string, Record<string, unknown>>;

		// Start from built-in, then overlay user-defined profiles
		const allProfiles: Record<string, ModelProfile> = { ...BUILTIN_PROFILES };

		for (const [name, profileDef] of Object.entries(userProfiles)) {
			const base = allProfiles[name] ?? BUILTIN_PROFILES[DEFAULT_PROFILE_NAME];
			allProfiles[name] = mergeIntoProfile(base, profileDef);
		}

		const selected = allProfiles[profileName];
		if (selected) return selected;

		// Fallback: if the named profile doesn't exist, try built-in
		const builtin = BUILTIN_PROFILES[profileName];
		if (builtin) return builtin;
	}

	// ── Legacy flat config mode ─────────────────────────────────────
	const hasLegacyFields =
		raw.classifier !== undefined || raw.routing !== undefined || raw.largeContext !== undefined;

	if (hasLegacyFields) {
		return mergeIntoProfile(BUILTIN_PROFILES[DEFAULT_PROFILE_NAME], raw);
	}

	// ── Default ─────────────────────────────────────────────────────
	return BUILTIN_PROFILES[DEFAULT_PROFILE_NAME];
}

/**
 * Load config (alias for resolveProfile for backward compatibility).
 *
 * Returns a ModelProfile — the resolved effective profile.
 */
export function loadConfig(cwd: string = process.cwd()): ModelProfile {
	return resolveProfile(cwd);
}

/** Invalidate the in-memory cache (useful for testing / reload) */
export function clearCache(): void {
	cachedRaw = null;
	cachedKey = null;
}

export function configFilePath(cwd: string = process.cwd()): string | null {
	return configPath(cwd);
}

export function defaultProfile(): ModelProfile {
	return BUILTIN_PROFILES[DEFAULT_PROFILE_NAME];
}

/** List available built-in profile names */
export function listProfiles(): string[] {
	return Object.keys(BUILTIN_PROFILES);
}

/** Return a copy of the built-in profiles (not user-overlaid) */
export function builtinProfiles(): Record<string, ModelProfile> {
	return { ...BUILTIN_PROFILES };
}
