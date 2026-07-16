import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { execSync } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('ci-watch');

const MAX_ATTEMPTS = 3;
const DEFAULT_POLL_MIN_MS = 30_000;
const DEFAULT_POLL_MAX_MS = 60_000;
const DEFAULT_POLL_STEP_MS = 15_000;

interface CiCheckResult {
	status: 'pass' | 'fail' | 'pending' | 'error';
	failedRuns: string[];
	logs: string;
}

interface PollConfig {
	minMs: number;
	maxMs: number;
	stepMs: number;
}

function nextPollDelay(current: number, config: PollConfig): number {
	const next = current + config.stepMs;
	if (next > config.maxMs) return config.minMs;
	return next;
}

function runGh(args: string, cwd: string): string {
	try {
		return execSync(`gh ${args}`, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`gh ${args} failed: ${msg}`);
	}
}

/** Validate that a branch name contains only safe characters for shell interpolation. */
function isValidBranch(branch: string): boolean {
	return /^[a-zA-Z0-9_\-./]+$/.test(branch);
}

function getCiStatus(prNumber: string, cwd: string): CiCheckResult {
	try {
		const output = runGh(`pr checks ${prNumber} --json name,state,bucket`, cwd);
		const checks = JSON.parse(output) as Array<{ name: string; state: string; bucket: string }>;

		const pending = checks.some((c) => c.bucket === 'pending');
		if (pending) return { status: 'pending', failedRuns: [], logs: '' };

		const failed = checks.filter((c) => c.bucket === 'fail');
		if (failed.length === 0) return { status: 'pass', failedRuns: [], logs: '' };

		return { status: 'fail', failedRuns: failed.map((f) => f.name), logs: '' };
	} catch (e) {
		return { status: 'error', failedRuns: [], logs: String(e) };
	}
}

function getFailedLogs(prNumber: string, cwd: string): string {
	try {
		const branchOutput = runGh(`pr view ${prNumber} --json headRefName -q .headRefName`, cwd);
		if (!isValidBranch(branchOutput)) {
			throw new Error(`Invalid branch name from PR: ${branchOutput}`);
		}
		const runListOutput = runGh(
			`run list --branch ${branchOutput} --limit 5 --json databaseId,status,conclusion`,
			cwd,
		);
		const runs = JSON.parse(runListOutput) as Array<{
			databaseId: number;
			status: string;
			conclusion: string;
		}>;
		const failedRun = runs.find((r) => r.conclusion === 'failure');

		if (!failedRun) return 'No failed run found in recent history.';

		const logs = runGh(`run view ${failedRun.databaseId} --log-failed`, cwd);
		const truncated = logs.split('\n').slice(-100).join('\n');
		return truncated;
	} catch (e) {
		return `Error fetching logs: ${String(e)}`;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
	let pollConfig: PollConfig = {
		minMs: DEFAULT_POLL_MIN_MS,
		maxMs: DEFAULT_POLL_MAX_MS,
		stepMs: DEFAULT_POLL_STEP_MS,
	};

	let autoMode = true;

	let ghChecked = false;

	pi.on('session_start', async (_event, ctx) => {
		if (ghChecked) return;
		ghChecked = true;
		try {
			execSync('command -v gh', { encoding: 'utf-8', stdio: 'pipe' });
			autoMode = true;
			ctx.ui.notify(
				'✅ ci-watch: 检测到 gh CLI，CI 自动监控已启用（推送后自动监控）',
				'info',
			);
		} catch {
			autoMode = false;
			ctx.ui.notify(
				'⚠️ ci-watch: 未检测到 gh CLI。CI 监控需要 GitHub CLI。安装方法：brew install gh / apt install gh',
				'error',
			);
		}
	});

	// 从推送输出中提取分支名
	function extractBranch(text: string): string | null {
		const trackMatch = text.match(/branch '([^']+)' set up to track/);
		if (trackMatch) return trackMatch[1];
		const newBranchMatch = text.match(/\*\s+\[new branch\]\s+(\S+)\s*->\s*\S+/);
		if (newBranchMatch) return newBranchMatch[1];
		const existingMatch = text.match(/\S+\.\.\S+\s+(\S+)\s*->\s*\S+/);
		if (existingMatch) return existingMatch[1];
		return null;
	}

	pi.on('tool_result', async (event, ctx) => {
		if (!autoMode) return;
		if (event.toolName !== 'bash') return;

		const content = event.content;
		if (!Array.isArray(content)) return;

		const text = content
			.map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
			.join('');

		// 检测 GitHub push 成功
		if (!/To github\.com/.test(text)) return;
		log.debug('bash 输出中检测到 GitHub push');

		// 使用 extractBranch 提取分支名
		let branch: string | null = extractBranch(text);

		// 兜底：直接获取当前分支
		if (!branch) {
			try {
				branch = execSync('git branch --show-current', {
					cwd: ctx.cwd,
					encoding: 'utf-8',
					timeout: 5000,
				}).trim();
			} catch (gitErr) {
				log.debug('git branch --show-current 兜底失败', { error: String(gitErr) });
			}
		}

		if (!branch) {
			log.debug('无法从 push 输出确定分支');
			return;
		}
		log.debug('自动监控检测到分支', { branch });

		// 验证分支名防止 shell 注入
		if (!isValidBranch(branch)) {
			log.warn('分支名包含不安全字符，跳过自动监控', { branch });
			return;
		}

		try {
			const prOutput = runGh(
				`pr list --head ${branch} --json number -q .[0].number`,
				ctx.cwd,
			);
			if (prOutput) {
				log.debug('找到分支对应的 PR', { branch, pr: prOutput });

				// 检查是否存在 CI 检查
				let hasChecks = false;
				try {
					const checksOutput = runGh(`pr checks ${prOutput} --json name`, ctx.cwd);
					const checks = JSON.parse(checksOutput);
					if (Array.isArray(checks) && checks.length > 0) hasChecks = true;
				} catch (checksErr) {
					log.warn('检查 CI 状态失败，跳过自动监控', {
						pr: prOutput,
						error: String(checksErr),
					});
					return;
				}

				if (!hasChecks) {
					log.debug('该 PR 没有 CI 检查，跳过自动监控', { pr: prOutput });
					return;
				}

				log.info('触发 CI 自动监控', { pr: prOutput, branch });
				pi.sendUserMessage(
					`CI 自动监控已触发。正在监控 PR ${prOutput} 的 CI 状态。如果失败，读取错误日志、修复代码、提交、推送，然后重新尝试，直到 CI 通过（最多 3 次）。`,
					{ deliverAs: 'followUp' },
				);
			}
		} catch {
			log.debug('未找到分支对应的 PR（分支还没有 PR 时属于正常情况）', { branch });
		}
	});

	pi.registerCommand('ci-auto', {
		description: '切换每次推送后自动监控 CI（默认：gh 可用时开启）。用法：/ci-auto on|off',
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (arg === 'on') {
				autoMode = true;
				ctx.ui.notify('🔄 CI 自动监控：已开启 — 推送后将自动监控 CI', 'info');
			} else if (arg === 'off') {
				autoMode = false;
				ctx.ui.notify('⏹️ CI 自动监控：已关闭', 'info');
			} else {
				ctx.ui.notify(
					`CI 自动监控：${autoMode ? '开启' : '关闭'}。使用 /ci-auto on|off 切换`,
					'info',
				);
			}
		},
	});

	pi.registerCommand('ci-config', {
		description: '配置 CI 轮询间隔（秒）。用法：/ci-config <最小值> <最大值> <步长>',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(
					`当前配置：最小=${pollConfig.minMs / 1000}s，最大=${pollConfig.maxMs / 1000}s，步长=${pollConfig.stepMs / 1000}s`,
					'info',
				);
				return;
			}
			const parts = args.trim().split(/\s+/).map(Number);
			if (parts.length < 3 || parts.some(isNaN)) {
				ctx.ui.notify(
					'用法：/ci-config <最小值> <最大值> <步长>（秒）。示例：/ci-config 20 90 10',
					'error',
				);
				return;
			}
			pollConfig = {
				minMs: parts[0] * 1000,
				maxMs: parts[1] * 1000,
				stepMs: parts[2] * 1000,
			};
			ctx.ui.notify(`✅ CI 轮询：${parts[0]}s → ${parts[1]}s（步长 ${parts[2]}s）`, 'info');
		},
	});
	pi.registerTool({
		name: 'ci_watch',
		label: 'CI 监控',
		description:
			'监控 GitHub PR 的 CI 状态，等待完成并报告结果。如果 CI 失败，返回失败日志供修复后重新推送。在打开 PR 后使用此工具确保 CI 通过。',
		promptSnippet: '监控 PR 的 CI 状态，等待完成，如有失败则返回日志',
		promptGuidelines: [
			'当用户要求监控 CI 时，在推送分支或打开 PR 后使用 ci_watch。',
			'ci_watch 报告失败后，读取日志、修复问题、提交、推送，然后重新调用 ci_watch（最多 3 次尝试）。',
			'不要主动调用 ci_watch —— 仅当用户明确要求监控 CI 时使用。',
		],
		parameters: Type.Object({
			pr: Type.String({ description: '要监控的 PR 编号或分支名' }),
			attempt: Type.Optional(
				Type.Number({ description: '当前修复尝试次数（1-3）。首次检查省略此参数。' }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { pr } = params;
			const attempt = params.attempt ?? 1;

			if (attempt > MAX_ATTEMPTS) {
				return {
					content: [
						{
							type: 'text',
							text: `❌ CI 在经过 ${MAX_ATTEMPTS} 次修复后仍然失败。需要手动干预。`,
						},
					],
					details: { status: 'max_attempts_reached', pr, attempts: MAX_ATTEMPTS },
				};
			}

			onUpdate?.({
				content: [
					{
						type: 'text',
						text: `⏳ 正在监控 PR ${pr} 的 CI（第 ${attempt}/${MAX_ATTEMPTS} 次尝试）...`,
					},
				],
				details: {},
			});

			let elapsed = 0;
			let currentDelay = pollConfig.minMs;
			const maxWait = 10 * 60 * 1000;

			while (!signal?.aborted) {
				const result = getCiStatus(pr, ctx.cwd);

				if (result.status === 'error') {
					return {
						content: [{ type: 'text', text: `检查 CI 出错：${result.logs}` }],
						details: { status: 'error', pr },
					};
				}

				if (result.status === 'pass') {
					return {
						content: [{ type: 'text', text: `✅ PR ${pr} 的 CI 已通过！` }],
						details: { status: 'pass', pr, attempt },
					};
				}

				if (result.status === 'fail') {
					const logs = getFailedLogs(pr, ctx.cwd);
					return {
						content: [
							{
								type: 'text',
								text: `❌ PR ${pr} 的 CI 失败（第 ${attempt}/${MAX_ATTEMPTS} 次尝试）。\n\n失败的检查：${result.failedRuns.join('、')}\n\n--- 失败日志（最后 100 行） ---\n${logs}\n\n---\n修复问题后提交、推送，然后以 attempt=${attempt + 1} 重新调用 ci_watch。`,
							},
						],
						details: { status: 'fail', pr, attempt, failedChecks: result.failedRuns },
					};
				}

				if (elapsed >= maxWait) {
					return {
						content: [
							{
								type: 'text',
								text: `⏰ PR ${pr} 的 CI 已等待 10 分钟仍未完成。请手动检查。`,
							},
						],
						details: { status: 'timeout', pr },
					};
				}

				await sleep(currentDelay);
				elapsed += currentDelay;
				currentDelay = nextPollDelay(currentDelay, pollConfig);
				onUpdate?.({
					content: [
						{
							type: 'text',
							text: `⏳ PR ${pr} 的 CI 仍在运行...（已过 ${Math.round(elapsed / 1000)} 秒，下次检查 ${currentDelay / 1000} 秒后）`,
						},
					],
					details: {},
				});
			}

			return {
				content: [{ type: 'text', text: 'CI 监控已取消。' }],
				details: { status: 'cancelled', pr },
			};
		},
	});

	pi.registerTool({
		name: 'ci_notify',
		label: 'CI 通知',
		description:
			'监控 GitHub PR 的 CI 状态并在完成时通知。不自动修复 —— 只监控并报告最终状态。当你希望在 CI 完成时得到通知时使用。',
		promptSnippet: '监控 PR 的 CI，完成后通知（不自动修复）',
		promptGuidelines: [
			'用户想知道 CI 何时完成但不希望自动修复时，使用 ci_notify。',
			'用户希望在失败时自动修复时，使用 ci_watch 代替。',
		],
		parameters: Type.Object({
			pr: Type.String({ description: '要监控的 PR 编号或分支名' }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { pr } = params;

			onUpdate?.({
				content: [{ type: 'text', text: `👀 正在监控 PR ${pr} 的 CI...` }],
				details: {},
			});

			let elapsed = 0;
			let currentDelay = pollConfig.minMs;
			const maxWait = 15 * 60 * 1000;

			while (!signal?.aborted) {
				const result = getCiStatus(pr, ctx.cwd);

				if (result.status === 'error') {
					return {
						content: [{ type: 'text', text: `检查 CI 出错：${result.logs}` }],
						details: { status: 'error', pr },
					};
				}

				if (result.status === 'pass') {
					ctx.ui.notify(`✅ PR ${pr} 的 CI 已通过！`, 'info');
					return {
						content: [{ type: 'text', text: `✅ PR ${pr} 的 CI 已通过！` }],
						details: { status: 'pass', pr },
					};
				}

				if (result.status === 'fail') {
					const logs = getFailedLogs(pr, ctx.cwd);
					ctx.ui.notify(`❌ PR ${pr} 的 CI 失败`, 'error');
					return {
						content: [
							{
								type: 'text',
								text: `❌ PR ${pr} 的 CI 失败。\n\n失败的检查：${result.failedRuns.join('、')}\n\n--- 失败日志（最后 100 行） ---\n${logs}`,
							},
						],
						details: { status: 'fail', pr, failedChecks: result.failedRuns },
					};
				}

				if (elapsed >= maxWait) {
					return {
						content: [
							{
								type: 'text',
								text: `⏰ PR ${pr} 的 CI 已等待 15 分钟仍未完成。请手动检查。`,
							},
						],
						details: { status: 'timeout', pr },
					};
				}

				await sleep(currentDelay);
				elapsed += currentDelay;
				currentDelay = nextPollDelay(currentDelay, pollConfig);
				onUpdate?.({
					content: [
						{
							type: 'text',
							text: `👀 PR ${pr} 的 CI 仍在运行...（已过 ${Math.round(elapsed / 1000)} 秒，下次检查 ${currentDelay / 1000} 秒后）`,
						},
					],
					details: {},
				});
			}

			return {
				content: [{ type: 'text', text: 'CI 监控已取消。' }],
				details: { status: 'cancelled', pr },
			};
		},
	});

	pi.registerCommand('ci-watch', {
		description: '监控 PR 的 CI 并自动修复失败。用法：/ci-watch <pr编号>',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify('用法：/ci-watch <pr编号>', 'error');
				return;
			}
			pi.sendUserMessage(
				`正在监控 PR ${args.trim()} 的 CI 状态。如果失败，读取错误日志、修复代码、提交、推送，然后重新尝试，直到 CI 通过（最多 3 次）。`,
				{ deliverAs: 'followUp' },
			);
		},
	});

	pi.registerCommand('ci-notify', {
		description: '监控 PR 的 CI，完成后通知（不自动修复）。用法：/ci-notify <pr编号>',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify('用法：/ci-notify <pr编号>', 'error');
				return;
			}
			pi.sendUserMessage(
				`请监控 PR ${args.trim()} 的 CI，完成后通知我。不要自动修复任何东西。`,
				{ deliverAs: 'followUp' },
			);
		},
	});
}
