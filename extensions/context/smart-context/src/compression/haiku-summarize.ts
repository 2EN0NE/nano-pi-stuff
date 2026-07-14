import { getComplete } from "../host-ai.js";
import { loadConfig } from "../config.js";
import { createHash } from "node:crypto";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("smart-context:summarize");

const SUMMARIZE_PROMPT = `You compress conversation messages for an AI coding agent's context. Produce a dense summary that preserves ALL load-bearing facts: decisions made, file paths, function/variable names, API contracts, error messages, requirements, and open questions. Drop filler, pleasantries, and verbose explanations.

Output ONLY the compressed summary, no preamble. Be terse but lossless on facts.`;

export function createSummarizer() {
	const cache = new Map<string, string>();
	let calls = 0;
	let cacheHits = 0;

	async function summarize(text: string, ctx: any): Promise<string | null> {
		const key = createHash("sha256").update(text).digest("hex").slice(0, 16);
		const cached = cache.get(key);
		if (cached !== undefined) {
			cacheHits++;
			log.debug("Cache hit", {
				key,
				originalLen: text.length,
				summaryLen: cached.length,
			});
			return cached;
		}

		const { classifier } = loadConfig(ctx.cwd);
		const model = ctx.modelRegistry?.find?.(
			classifier.provider,
			classifier.model,
		);
		if (!model) {
			log.warn("No classifier model found, skipping summarize", {
				provider: classifier.provider,
				model: classifier.model,
			});
			return null;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			log.warn("Auth failed for summarizer model", {
				provider: classifier.provider,
				model: classifier.model,
			});
			return null;
		}

		try {
			calls++;
			log.debug("Calling summarizer model", {
				provider: classifier.provider,
				model: classifier.model,
				inputLen: text.length,
				callNumber: calls,
			});

			const complete = await getComplete();
			if (!complete) {
				log.warn("Host complete() not available");
				return null;
			}

			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `<message>\n${text}\n</message>`,
								},
							],
							timestamp: Date.now(),
						},
					],
					systemPrompt: SUMMARIZE_PROMPT,
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: Math.min(1024, Math.ceil(text.length / 8)),
					signal: ctx.signal,
				},
			);

			const summary = response.content
				.filter(
					(c: {
						type: string;
						text?: string;
					}): c is { type: "text"; text: string } =>
						c.type === "text" && typeof c.text === "string",
				)
				.map((c: { text: string }) => c.text.trim())
				.join("\n");

			if (!summary) {
				log.warn("Summarizer returned empty response");
				return null;
			}

			const ratio = Math.round((1 - summary.length / text.length) * 100);
			log.info(
				"Summarization complete | original=%s summary=%s ratio=%s%% key=%s",
				text.length,
				summary.length,
				ratio,
				key,
			);

			cache.set(key, summary);
			return summary;
		} catch (err) {
			log.error("Summarizer model call failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	function getStats() {
		return { calls, cacheHits };
	}

	return { summarize, getStats };
}

export type Summarizer = ReturnType<typeof createSummarizer>;
