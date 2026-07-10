/**
 * Chinese message library for whimsical extension.
 *
 * Organized by dimension × sigma level (0 = normal, 1 = elevated, 2 = extreme).
 * Each key is "{dimensionKey}-{level}" where dimensionKey is one of:
 *   - thinkingSteps
 *   - avgTurnsPerQuestion
 *   - userQuestions
 *   - toolTypesUsed
 *
 * Messages relate to difficulty or what's being done (filtered from the original
 * English list, translated to Chinese).
 *
 * Extensible: add new dimension keys following the same naming pattern.
 */

import { createLogger } from "@zenone/pi-logger";

const log = createLogger("whimsical:messages");

export type DimensionKey =
	| "thinkingSteps"
	| "avgTurnsPerQuestion"
	| "userQuestions"
	| "toolTypesUsed";

/**
 * All dimension keys in priority order (for tie-breaking).
 */
export const DIMENSION_KEYS: DimensionKey[] = [
	"thinkingSteps",
	"avgTurnsPerQuestion",
	"userQuestions",
	"toolTypesUsed",
];

/**
 * Message pool: dimension-level → array of Chinese messages.
 * Level 0 = within 1σ (normal), Level 1 = 1-2σ (unusual), Level 2 = 2σ+ (extreme).
 */
const MESSAGES: Record<string, string[]> = {
	// ========== 思考步骤数 (thinkingSteps) ==========
	"thinkingSteps-0": [
		"思考中...",
		"小小思索一下...",
		"正在琢磨...",
		"走一遍逻辑...",
		"快速推演中...",
	],
	"thinkingSteps-1": [
		"深度推理中...",
		"思路有点绕，捋一捋...",
		"正在多方面权衡...",
		"拆解复杂问题中...",
		"推演多条路径...",
	],
	"thinkingSteps-2": [
		"脑力全开中...",
		"复杂推理中，请稍候...",
		"正在攻克难点...",
		"多层次演绎推理中...",
		"正在穿越思维迷宫...",
	],

	// ========== 平均每轮/问题 (avgTurnsPerQuestion) ==========
	"avgTurnsPerQuestion-0": [
		"快速搞定...",
		"马上就绪...",
		"一步到位...",
		"轻车熟路...",
		"顺手解决...",
	],
	"avgTurnsPerQuestion-1": [
		"多绕了几圈...",
		"路有点曲折...",
		"正在来回确认...",
		"多试了几条路...",
		"迂回前进中...",
	],
	"avgTurnsPerQuestion-2": [
		"还在兜圈子...",
		"这条路不太好走...",
		"摸索中前进...",
		"尝试不同方案...",
		"正在反复验证...",
	],

	// ========== 用户提问次数 (userQuestions) ==========
	"userQuestions-0": [
		"刚开工...",
		"热身中...",
		"刚开始探索...",
		"暖场中...",
		"初次接触代码库...",
	],
	"userQuestions-1": [
		"渐入佳境...",
		"已经有感觉了...",
		"深入探索中...",
		"步步推进中...",
		"正在扩大探索范围...",
	],
	"userQuestions-2": [
		"持久战中...",
		"深水区探索中...",
		"长时间奋战中...",
		"持续攻坚中...",
		"马拉松模式进行中...",
	],

	// ========== 工具类型数 (toolTypesUsed) ==========
	"toolTypesUsed-0": [
		"基本工具足够了...",
		"轻装上阵...",
		"一把螺丝刀搞定...",
		"简单工具走天下...",
		"正在翻工具箱...",
	],
	"toolTypesUsed-1": [
		"工具箱渐满...",
		"工具组合中...",
		"多工具协同...",
		"正在调用各种工具...",
		"工具箱越来越热闹了...",
	],
	"toolTypesUsed-2": [
		"十八般武艺全上...",
		"全方位出击...",
		"全副武装中...",
		"多路并进...",
		"所有工具随时待命...",
	],
};

/**
 * Get a random message for a given dimension and sigma level.
 */
export function pickMessage(
	dimensionKey: DimensionKey,
	level: 0 | 1 | 2,
): string {
	const key = `${dimensionKey}-${level}`;
	const pool = MESSAGES[key];
	if (!pool || pool.length === 0) {
		log.warn(`No messages for ${key}, falling back`);
		return "工作中...";
	}
	return pool[Math.floor(Math.random() * pool.length)];
}
