/**
 * pi-logger 扩展 — Vitest e2e 测试示例
 *
 * 演示如何使用 Vitest + sandbox helpers 编写结构化 e2e 测试。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	createSandbox,
	destroySandbox,
	runPi,
	readLogs,
	hasErrorInLogs,
} from '../helpers/sandbox.js';

describe('pi-logger extension', () => {
	let sandbox: string;

	beforeAll(() => {
		sandbox = createSandbox({
			extensions: ['pi-logger'],
			useMockLLM: true,
		});
	});

	afterAll(() => {
		destroySandbox(sandbox);
	});

	it('loads without crashes', async () => {
		const result = await runPi(sandbox, 'hi');
		// exit code 0 或 124（timeout）都算通过
		expect([0, 124]).toContain(result.exitCode);
	}, 60_000);

	it('produces log files', async () => {
		const result = await runPi(sandbox, 'hi');
		const logs = readLogs(result.logDir);
		expect(Object.keys(logs).length).toBeGreaterThan(0);
	}, 60_000);

	it('has no ERROR in logs', async () => {
		const result = await runPi(sandbox, 'hi');
		expect(hasErrorInLogs(result.logDir)).toBe(false);
	}, 60_000);
});
