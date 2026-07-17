/**
 * Mock LLM Provider — 共享测试辅助扩展
 *
 * 注册虚假 LLM provider，使 pi 无需真实 API Key 即可启动，
 * 让扩展的 session_start / 命令注册等流程可以完整执行。
 *
 * 默认回复："Mock LLM is ready."
 *
 * 使用方式（在 smoke.test.sh 中）：
 *   run_pi_and_check --extensions "mock-llm,目标扩展" --prompt "hi"
 *
 * 通过在依赖列表中列出 "mock-llm" 即可自动纳入沙箱。
 * （run_pi_and_check 会从 test/helpers/ 搜索扩展文件）。
 *
 * 注意：同时通过 pi.registerProvider() 和 registerFauxProvider() 双重注册，
 * 确保 ctx.modelRegistry 能找到 mock 模型。
 */

import { registerFauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const MOCK_PROVIDER = 'mock-llm';
const MOCK_MODEL_ID = 'mock-model-1';

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider({
		provider: MOCK_PROVIDER,
		models: [{ id: MOCK_MODEL_ID, name: 'Mock Model' }],
	});

	// 默认回复
	faux.setResponses([fauxAssistantMessage('Mock LLM is ready.')]);

	// 通过 Extension API 再次注册，确保 ctx.modelRegistry 可找到 mock 模型
	// faux.api 包含动态生成的 UUID（如 faux:1234567890:xxxx），必须用于 api 字段
	// 类型标注用 any 绕过 pi-ai 与 pi-coding-agent 的类型版本差异
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	pi.registerProvider(
		MOCK_PROVIDER as any,
		{
			name: 'Mock LLM Provider',
			api: faux.api,
			baseUrl: 'http://localhost:0',
			apiKey: 'mock-key-noop',
			models: faux.models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				api: (faux as any).api,
				provider: MOCK_PROVIDER,
				apiKey: 'mock-key-noop',
				baseUrl: 'http://localhost:0',
				input: ['text'] as const,
				reasoning: false,
				cost: { input: 0, output: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			})),
		} as any,
	);

	pi.on('session_start', async (_event, ctx) => {
		const model = ctx.modelRegistry.find(MOCK_PROVIDER, MOCK_MODEL_ID);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) {
				console.error('[mock-llm] FAILED to switch to mock model');
			}
		}
	});
}
