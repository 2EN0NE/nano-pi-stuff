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
	/**
	 * 失败的检查/run 名称列表。
	 * - PR 模式：check 的 name（来自 `gh pr checks`）
	 * - 分支模式：workflow run 的 name（来自 `gh run list`）
	 */
	failedRuns: string[];
	logs: string;
	/**
	 * 分支模式专用：标记 pending 是因为分支还没有 run（可能是 CI 尚未触发），
	 * 区别于 run 正在执行中的 pending。轮询循环利用此字段对空 run 场景快速超时。
	 */
	noRunsFound?: boolean;
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

/** Check if input is a PR number (digits only) */
function isPrRef(input: string): boolean {
	return /^\d+$/.test(input);
}

/** Resolve input to a branch name — PR numbers resolved via gh, branch names returned as-is */
function resolveBranch(prOrBranch: string, cwd: string): string {
	if (isPrRef(prOrBranch)) {
		return runGh(`pr view ${prOrBranch} --json headRefName -q .headRefName`, cwd);
	}
	return prOrBranch;
}

function getCiStatusFromPr(prNumber: string, cwd: string): CiCheckResult {
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

function getCiStatusFromBranch(branch: string, cwd: string): CiCheckResult {
	try {
		if (!isValidBranch(branch)) {
			return { status: 'error', failedRuns: [], logs: `Invalid branch name: ${branch}` };
		}
		const output = runGh(
			`run list --branch ${branch} --limit 1 --json name,status,conclusion,databaseId`,
			cwd,
		);
		const runs = JSON.parse(output) as Array<{
			name: string;
			status: string;
			conclusion: string;
			databaseId: number;
		}>;
		const latest = runs[0];
		if (!latest) {
			// 分支没有 run — 做一次仓库级检查区分"CI 未配置"和"CI 还没开始"
			try {
				const repoOutput = runGh('run list --limit 1 --json databaseId', cwd);
				const repoRuns = JSON.parse(repoOutput) as Array<{ databaseId: number }>;
				if (!repoRuns.length) {
					return {
						status: 'error',
						failedRuns: [],
						logs: '该仓库没有发现任何 GitHub Actions 运行。请确认 Actions 已启用（Settings > Actions > General）。',
					};
				}
			} catch {
				// repo 级检查失败时降级到 pending，防止因 gh API 波动误报
			}
			return {
				status: 'pending',
				failedRuns: [],
				logs: '',
				noRunsFound: true,
			};
		}
		if (latest.status !== 'completed') return { status: 'pending', failedRuns: [], logs: '' };
		if (latest.conclusion === 'success' || latest.conclusion === 'neutral') {
			return { status: 'pass', failedRuns: [], logs: '' };
		}
		return {
			status: 'fail',
			failedRuns: [latest.name ?? `run#${latest.databaseId}`],
			logs: '',
		};
	} catch (e) {
		return { status: 'error', failedRuns: [], logs: String(e) };
	}
}

/** 根据输入自动选择 PR 模式或分支模式 */
function getCiStatus(prOrBranch: string, cwd: string): CiCheckResult {
	if (isPrRef(prOrBranch)) {
		return getCiStatusFromPr(prOrBranch, cwd);
	}
	return getCiStatusFromBranch(prOrBranch, cwd);
}

function getFailedLogs(prOrBranch: string, cwd: string): string {
	try {
		const branch = resolveBranch(prOrBranch, cwd);
		if (!isValidBranch(branch)) {
			throw new Error(`Invalid branch name: ${branch}`);
		}
		const runListOutput = runGh(
			`run list --branch ${branch} --limit 5 --json databaseId,status,conclusion`,
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
				// PR 模式
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

				log.info('触发 CI 自动监控（PR 模式）', { pr: prOutput, branch });
				pi.sendUserMessage(
					`CI 自动监控已触发。正在监控 PR ${prOutput} 的 CI 状态。如果失败，读取错误日志、修复代码、提交、推送，然后重新尝试，直到 CI 通过（最多 3 次）。`,
					{ deliverAs: 'followUp' },
				);
				return;
			}

			// 没有 PR → 分支模式：直接检查该分支是否有 CI run
			log.debug('未找到 PR，尝试分支模式自动监控', { branch });

			let hasRuns = false;
			try {
				const runsOutput = runGh(
					`run list --branch ${branch} --limit 1 --json databaseId`,
					ctx.cwd,
				);
				const runs = JSON.parse(runsOutput);
				if (Array.isArray(runs) && runs.length > 0) hasRuns = true;
			} catch (runsErr) {
				log.warn('检查分支 CI 状态失败，跳过自动监控', {
					branch,
					error: String(runsErr),
				});
				return;
			}

			if (!hasRuns) {
				log.debug('该分支没有 CI run，跳过自动监控', { branch });
				return;
			}

			log.info('触发 CI 自动监控（分支模式）', { branch });
			pi.sendUserMessage(
				`CI 自动监控已触发（分支模式）。正在监控分支 ${branch} 的 CI 状态。如果失败，读取错误日志、修复代码、提交、推送，然后重新尝试，直到 CI 通过（最多 3 次）。`,
				{ deliverAs: 'followUp' },
			);
		} catch (autoErr) {
			log.warn('自动监控异常', { branch, error: String(autoErr) });
			ctx.ui.notify(
				`⚠️ ci-watch: 自动监控分支 ${branch} 时出错（${typeof autoErr === 'string' ? autoErr.slice(0, 80) : 'API 调用失败'}）。请手动使用 /ci-watch 或 /ci-notify。`,
				'error',
			);
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
			'监控 GitHub PR 或分支的 CI 状态，等待完成并报告结果。如果 CI 失败，返回失败日志供修复后重新推送。支持 PR 编号（如 12）或分支名（如 main）。',
		promptSnippet: '监控 PR 或分支的 CI 状态，等待完成，如有失败则返回日志',
		promptGuidelines: [
			'当用户要求监控 CI 时，在推送分支或打开 PR 后使用 ci_watch。支持 PR 编号或分支名。',
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
			const refLabel = isPrRef(pr) ? `PR ${pr}` : `分支 ${pr}`;
			const refShort = isPrRef(pr) ? `PR ${pr}` : pr;

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
						text: `⏳ 正在监控 ${refLabel} 的 CI（第 ${attempt}/${MAX_ATTEMPTS} 次尝试）...`,
					},
				],
				details: {},
			});

			let elapsed = 0;
			let currentDelay = pollConfig.minMs;
			const maxWait = 10 * 60 * 1000;
			let consecutiveEmptyPolls = 0;
			const maxEmptyPolls = 3; // ~60-90s 连续未发现 run → 快速失败

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
						content: [{ type: 'text', text: `✅ ${refLabel} 的 CI 已通过！` }],
						details: { status: 'pass', pr, attempt },
					};
				}

				if (result.status === 'fail') {
					const logs = getFailedLogs(pr, ctx.cwd);
					return {
						content: [
							{
								type: 'text',
								text: `❌ ${refLabel} 的 CI 失败（第 ${attempt}/${MAX_ATTEMPTS} 次尝试）。\n\n失败的检查：${result.failedRuns.join('、')}\n\n--- 失败日志（最后 100 行） ---\n${logs}\n\n---\n修复问题后提交、推送，然后以 attempt=${attempt + 1} 重新调用 ci_watch。`,
							},
						],
						details: { status: 'fail', pr, attempt, failedChecks: result.failedRuns },
					};
				}

				// 分支模式：连续多次无 run → fast-fail（避免笔误或未触发 CI 空等 10 分钟）
				if (result.noRunsFound) {
					consecutiveEmptyPolls++;
					if (consecutiveEmptyPolls >= maxEmptyPolls) {
						return {
							content: [
								{
									type: 'text',
									text: `⏹️ ${refLabel} 连续 ${maxEmptyPolls} 次检查未发现 CI run。确认分支名是否正确、CI 是否已触发。`,
								},
							],
							details: { status: 'error', pr, reason: 'no_ci_runs_found' },
						};
					}
				} else {
					consecutiveEmptyPolls = 0;
				}

				if (elapsed >= maxWait) {
					return {
						content: [
							{
								type: 'text',
								text: `⏰ ${refLabel} 的 CI 已等待 10 分钟仍未完成。请手动检查。`,
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
							text: `⏳ ${refShort} 的 CI 仍在运行...（已过 ${Math.round(elapsed / 1000)} 秒，下次检查 ${currentDelay / 1000} 秒后）`,
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
			'监控 GitHub PR 或分支的 CI 状态并在完成时通知。不自动修复 —— 只监控并报告最终状态。支持 PR 编号（如 12）或分支名（如 main）。',
		promptSnippet: '监控 PR 或分支的 CI，完成后通知（不自动修复）',
		promptGuidelines: [
			'用户想知道 CI 何时完成但不希望自动修复时，使用 ci_notify。',
			'用户希望在失败时自动修复时，使用 ci_watch 代替。',
		],
		parameters: Type.Object({
			pr: Type.String({ description: '要监控的 PR 编号或分支名' }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { pr } = params;
			const refLabel = isPrRef(pr) ? `PR ${pr}` : `分支 ${pr}`;
			const refShort = isPrRef(pr) ? `PR ${pr}` : pr;

			onUpdate?.({
				content: [{ type: 'text', text: `👀 正在监控 ${refLabel} 的 CI...` }],
				details: {},
			});

			let elapsed = 0;
			let currentDelay = pollConfig.minMs;
			const maxWait = 15 * 60 * 1000;
			let consecutiveEmptyPolls = 0;
			const maxEmptyPolls = 3; // ~60-90s 连续未发现 run → 快速失败

			while (!signal?.aborted) {
				const result = getCiStatus(pr, ctx.cwd);

				if (result.status === 'error') {
					return {
						content: [{ type: 'text', text: `检查 CI 出错：${result.logs}` }],
						details: { status: 'error', pr },
					};
				}

				if (result.status === 'pass') {
					ctx.ui.notify(`✅ ${refLabel} 的 CI 已通过！`, 'info');
					return {
						content: [{ type: 'text', text: `✅ ${refLabel} 的 CI 已通过！` }],
						details: { status: 'pass', pr },
					};
				}

				if (result.status === 'fail') {
					const logs = getFailedLogs(pr, ctx.cwd);
					ctx.ui.notify(`❌ ${refLabel} 的 CI 失败`, 'error');
					return {
						content: [
							{
								type: 'text',
								text: `❌ ${refLabel} 的 CI 失败。\n\n失败的检查：${result.failedRuns.join('、')}\n\n--- 失败日志（最后 100 行） ---\n${logs}`,
							},
						],
						details: { status: 'fail', pr, failedChecks: result.failedRuns },
					};
				}

				// 分支模式：连续多次无 run → fast-fail（避免笔误或未触发 CI 空等 15 分钟）
				if (result.noRunsFound) {
					consecutiveEmptyPolls++;
					if (consecutiveEmptyPolls >= maxEmptyPolls) {
						return {
							content: [
								{
									type: 'text',
									text: `⏹️ ${refLabel} 连续 ${maxEmptyPolls} 次检查未发现 CI run。确认分支名是否正确、CI 是否已触发。`,
								},
							],
							details: { status: 'error', pr, reason: 'no_ci_runs_found' },
						};
					}
				} else {
					consecutiveEmptyPolls = 0;
				}

				if (elapsed >= maxWait) {
					return {
						content: [
							{
								type: 'text',
								text: `⏰ ${refLabel} 的 CI 已等待 15 分钟仍未完成。请手动检查。`,
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
							text: `👀 ${refShort} 的 CI 仍在运行...（已过 ${Math.round(elapsed / 1000)} 秒，下次检查 ${currentDelay / 1000} 秒后）`,
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
		description: '监控 PR 或分支的 CI 并自动修复失败。用法：/ci-watch <pr编号|分支名>',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify('用法：/ci-watch <pr编号|分支名>', 'error');
				return;
			}
			const ref = args.trim();
			const refLabel = isPrRef(ref) ? `PR ${ref}` : `分支 ${ref}`;
			pi.sendUserMessage(
				`正在监控 ${refLabel} 的 CI 状态。如果失败，读取错误日志、修复代码、提交、推送，然后重新尝试，直到 CI 通过（最多 3 次）。`,
				{ deliverAs: 'followUp' },
			);
		},
	});

	pi.registerCommand('ci-notify', {
		description:
			'监控 PR 或分支的 CI，完成后通知（不自动修复）。用法：/ci-notify <pr编号|分支名>',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify('用法：/ci-notify <pr编号|分支名>', 'error');
				return;
			}
			const ref = args.trim();
			const refLabel = isPrRef(ref) ? `PR ${ref}` : `分支 ${ref}`;
			pi.sendUserMessage(`请监控 ${refLabel} 的 CI，完成后通知我。不要自动修复任何东西。`, {
				deliverAs: 'followUp',
			});
		},
	});
}
