/**
 * Compactor module — handles the actual summarization logic.
 *
 * This module creates the handler for session_before_compact events.
 * It uses the active profile's model and prompt to generate summaries.
 *
 * ⚠️ Auth resolution:
 *   pi-ai's complete() internally uses getEnvApiKey() which ONLY checks env vars.
 *   But users configure their API key through Pi's model registry (auth storage,
 *   settings.json, models.json), NOT through env vars. So we MUST resolve auth
 *   explicitly via ctx.modelRegistry.getApiKeyAndHeaders() and pass apiKey/headers
 *   in the options. Without this, the model call will fail with an auth error.
 */

import { type Api, type Model, complete } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
// @ts-expect-error — @zenone/pi-logger resolves api.ts at runtime
import { createLogger } from "@zenone/pi-logger";
import { getActiveProfile } from "./config.js";
import type { CompactionProfile } from "./types.js";
import { DEFAULT_COMPACTION_PROMPT } from "./types.js";

const log = createLogger("custom-compaction:compactor");

// ── Model resolution ────────────────────────────────────────────

/**
 * Resolve the model to use for compaction based on the active profile.
 *
 * Priority:
 * 1. profile.model is "current" → use ctx.model
 * 2. profile.model is "provider/modelId" → look up in registry
 * 3. Fallback: ctx.model (whatever Pi is currently using)
 *
 * Returns the full Model object (needed by complete() for api resolution).
 */
function resolveModel(
	profile: CompactionProfile,
	ctx: ExtensionContext,
): Model<Api> | null {
	if (profile.model === "current") {
		if (ctx.model) {
			return ctx.model;
		}
		log.warn("profile.model is 'current' but ctx.model is undefined");
		return null;
	}

	// profile.model is "provider/modelId"
	const slashIdx = profile.model.indexOf("/");
	if (slashIdx <= 0 || slashIdx >= profile.model.length - 1) {
		log.warn("invalid model spec in profile:", profile.model);
		return ctx.model ?? null;
	}

	const provider = profile.model.slice(0, slashIdx);
	const modelId = profile.model.slice(slashIdx + 1);

	const found = ctx.modelRegistry.find(provider, modelId);
	if (found) {
		return found;
	}

	log.warn("configured model not found in registry:", profile.model);
	return ctx.model ?? null;
}

// ── Compaction handler factory ──────────────────────────────────

/**
 * Build a handler for the session_before_compact event.
 *
 * This handler:
 * 1. Reads the active profile from config
 * 2. Resolves the model (current or specific)
 * 3. Summarizes ALL messages using the profile's prompt
 * 4. Returns custom compaction content
 */
export function buildCompactionHandler() {
	return async (
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
	): Promise<{
		compaction?: {
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
		};
	} | void> => {
		log.debug("session_before_compact fired");

		const profile = getActiveProfile();
		const modelInfo = resolveModel(profile, ctx);

		if (!modelInfo) {
			ctx.ui.notify(
				"Custom compaction: no model available, using default compaction",
				"warning",
			);
			return; // fall back to default
		}

		// If modelInfo differs from ctx.model, notify the user
		if (
			ctx.model &&
			(ctx.model.provider !== modelInfo.provider ||
				ctx.model.id !== modelInfo.id)
		) {
			ctx.ui.notify(
				`Compaction using ${modelInfo.provider}/${modelInfo.id}`,
				"info",
			);
		} else {
			ctx.ui.notify(
				`Compaction using current model (${modelInfo.provider}/${modelInfo.id})`,
				"info",
			);
		}

		const { preparation, signal } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
		} = preparation;

		// Combine all messages for full summary
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		ctx.ui.notify(
			`Custom compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens)...`,
			"info",
		);

		// Build the summarization prompt
		const conversationText = serializeConversation(convertToLlm(allMessages));
		const previousContext = previousSummary
			? `\n\nPrevious session summary for context:\n${previousSummary}`
			: "";

		// Use the profile's custom prompt, or the default
		const promptText = profile.prompt.trim() || DEFAULT_COMPACTION_PROMPT;

		const summaryMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `${promptText}${previousContext}

<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			// Resolve auth via Pi's model registry (NOT via pi-ai's getEnvApiKey).
			// pi-ai's complete() internally uses getEnvApiKey() which only checks env vars,
			// but users configure their API keys through Pi's model registry (auth storage,
			// settings.json, models.json). Without explicit resolution, the call fails
			// with an auth error.
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(modelInfo);
			const completeOptions: Record<string, unknown> = {
				maxTokens: 8192,
				signal,
			};
			if (auth.ok) {
				if (auth.apiKey) completeOptions.apiKey = auth.apiKey;
				if (auth.headers) completeOptions.headers = auth.headers;
			} else {
				log.error("Auth resolution failed:", auth.error);
				ctx.ui.notify(`Compaction auth failed: ${auth.error}`, "error");
				return; // fall back to default compaction
			}

			const response = await complete(
				modelInfo,
				{ messages: summaryMessages },
				completeOptions as any,
			);

			// Extract summary: prefer text content, fall back to thinking blocks,
			// then fall back to raw serialization of all content.
			let summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				// Try thinking blocks (some reasoning models return thinking-only)
				summary = response.content
					.filter(
						(c): c is { type: "thinking"; thinking: string } =>
							c.type === "thinking",
					)
					.map((c) => c.thinking)
					.join("\n");
			}

			if (!summary.trim()) {
				// Last resort: serialize all content blocks as JSON
				summary = response.content
					.map((c) => {
						if ("text" in c && typeof c.text === "string") return c.text;
						if ("thinking" in c && typeof c.thinking === "string")
							return c.thinking;
						try {
							return JSON.stringify(c);
						} catch {
							return "";
						}
					})
					.filter(Boolean)
					.join("\n");
			}

			if (!summary.trim()) {
				if (!signal.aborted) {
					const errorDetail = response.errorMessage
						? `: ${response.errorMessage}`
						: "";
					log.error("Empty compaction response", {
						stopReason: response.stopReason,
						errorMessage: response.errorMessage,
					});
					ctx.ui.notify(
						`Compaction response had no content (stopReason: ${response.stopReason}${errorDetail}), using default`,
						"warning",
					);
				}
				return;
			}

			log.info("Compaction summary generated", {
				length: summary.length,
				tokensBefore,
			});

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Compaction failed: ${message}`, "error");
			// Fall back to default compaction
			return;
		}
	};
}
