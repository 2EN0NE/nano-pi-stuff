import { createLogger } from '@zenone/pi-logger';
import { getComplete } from './host-ai.js';

const log = createLogger('pi-recap:summarize');

const RECAP_PROMPT = `You write a session recap for a developer returning to an AI coding session.

Read the conversation transcript and produce a SHORT recap of where things stand: what was being worked on, what was done, and what is still pending or the obvious next step.

Rules:
- 1 to 2 sentences, maximum ~240 characters total.
- Start directly with the substance. No "Recap:" prefix, no preamble, no bullet points.
- Mention concrete file paths, function names or decisions when they matter.
- If work is clearly unfinished, end by naming the pending step.
- Write in the same language the developer is using in the conversation.

Output ONLY the recap text.`;

type SummarizeCtx = {
	cwd?: string;
	modelRegistry?: {
		find?: (provider: string, model: string) => any;
		getApiKeyAndHeaders: (model: any) => Promise<{
			ok: boolean;
			apiKey?: string;
			headers?: Record<string, string>;
		}>;
	};
	model?: { provider?: string; id?: string; modelId?: string };
	signal?: AbortSignal;
};

function resolveModel(ctx: SummarizeCtx): any {
	const registry = ctx.modelRegistry;
	if (!registry?.find) return ctx.model ?? null;
	const provider = ctx.model?.provider;
	const modelId = ctx.model?.id ?? ctx.model?.modelId;
	if (provider && modelId) {
		const found = registry.find(provider, modelId);
		if (found) return found;
	}
	return ctx.model ?? null;
}

export async function summarizeRecap(
	transcript: string,
	ctx: SummarizeCtx,
): Promise<string | null> {
	const model = resolveModel(ctx);
	if (!model || !ctx.modelRegistry) {
		log.warn('No model or modelRegistry available, skipping recap');
		return null;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		log.warn('Auth failed for model', {
			provider: model?.provider,
			modelId: model?.id ?? model?.modelId,
		});
		return null;
	}

	const complete = await getComplete();
	if (!complete) {
		log.warn('No complete() function found from host pi-ai');
		return null;
	}

	try {
		const response = await complete(
			model,
			{
				systemPrompt: RECAP_PROMPT,
				messages: [
					{
						role: 'user' as const,
						content: [
							{
								type: 'text' as const,
								text: `<transcript>\n${transcript}\n</transcript>`,
							},
						],
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 200,
				signal: ctx.signal,
			},
		);

		const text = response.content
			.filter(
				(c: { type: string; text?: string }): c is { type: 'text'; text: string } =>
					c.type === 'text' && typeof c.text === 'string',
			)
			.map((c: { text: string }) => c.text.trim())
			.join(' ')
			.trim();

		if (text) {
			log.info('Recap generated successfully', { length: text.length });
		} else {
			log.debug('Recap response was empty');
		}
		return text || null;
	} catch (err) {
		log.error('Model call failed in summarizeRecap', {
			error: err instanceof Error ? err.message : String(err),
			provider: model?.provider,
			modelId: model?.id ?? model?.modelId,
		});
		throw err;
	}
}
