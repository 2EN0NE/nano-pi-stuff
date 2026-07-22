/**
 * worktree v2 — TUI 交互测试
 *
 * 使用 TuiRunner（node-pty + PI_TUI_WRITE_LOG）验证：
 * - 切换器面板渲染
 * - help 输出
 * - widget 切换
 */
import { describe, it, expect } from 'vitest';
import { withTui } from '../helpers/tui-runner.js';

describe('worktree v2 extension (TUI mode via node-pty)', () => {
	it('loads in TUI mode without crash', async () => {
		await withTui({ extensions: 'pi-logger,worktree', useMockLLM: true }, async (tui) => {
			await tui.waitForOutput('mock-model-1', 6000);
		});
	});

	it('/worktree (no args) opens switcher panel', async () => {
		await withTui({ extensions: 'pi-logger,worktree', useMockLLM: true }, async (tui) => {
			await tui.send('/worktree');
			await tui.waitForOutput('main', 10000);
			await tui.waitForOutput('Switch', 8000);
			await tui.sendRaw('\x1b');
		});
	});

	it('/worktree help shows commands', async () => {
		await withTui({ extensions: 'pi-logger,worktree', useMockLLM: true }, async (tui) => {
			await tui.send('/worktree help');
			await tui.waitForOutput('create', 10000);
			const text = tui.getText();
			expect(text).toContain('Usage:');
			expect(text).toContain('create');
			expect(text).toContain('delete');
			expect(text).toContain('widget');
			expect(text).not.toContain('/stop');
		});
	});

	it('/worktree widget on/off', async () => {
		await withTui({ extensions: 'pi-logger,worktree', useMockLLM: true }, async (tui) => {
			await tui.send('/worktree widget off');
			await tui.waitForOutput('hidden', 10000);
			await tui.send('/worktree widget on');
			await tui.waitForOutput('visible', 10000);
		});
	});
});
