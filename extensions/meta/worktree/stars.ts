/**
 * pi-worktree — 黄道十二宫 + 恒星名池
 *
 * 每个 worktree 自动分配一个 "{星座}-{恒星}" 名称，
 * 共 12 星座 × 3 主星 = 36 个唯一名，用尽后使用 "{星座}-minor~N" 后备。
 */

// 黄道十二宫及其主要恒星
export const STAR_NAMES: Array<{ constellation: string; stars: string[] }> = [
	{ constellation: 'Aries', stars: ['Hamal', 'Sheratan', 'Mesarthim'] },
	{ constellation: 'Taurus', stars: ['Aldebaran', 'Elnath', 'Alcyone'] },
	{ constellation: 'Gemini', stars: ['Pollux', 'Castor', 'Alhena'] },
	{ constellation: 'Cancer', stars: ['Acubens', 'Tarf', 'Praesepe'] },
	{ constellation: 'Leo', stars: ['Regulus', 'Denebola', 'Algieba'] },
	{ constellation: 'Virgo', stars: ['Spica', 'Porrima', 'Vindemiatrix'] },
	{ constellation: 'Libra', stars: ['Zubenelgenubi', 'Zubeneschamali', 'Brachium'] },
	{ constellation: 'Scorpius', stars: ['Antares', 'Shaula', 'Sargas'] },
	{ constellation: 'Sagittarius', stars: ['Kaus', 'Nunki', 'Albaldah'] },
	{ constellation: 'Capricornus', stars: ['Dabih', 'Algedi', 'Nashira'] },
	{ constellation: 'Aquarius', stars: ['Sadalmelik', 'Sadalsuud', 'Skat'] },
	{ constellation: 'Pisces', stars: ['Alrisha', 'Fumalsamakah', 'Torcular'] },
];

/** 生成完整名称池：「星座-恒星」 */
export function generateNamePool(): string[] {
	const pool: string[] = [];
	for (const entry of STAR_NAMES) {
		for (const star of entry.stars) {
			pool.push(`${entry.constellation}-${star}`);
		}
	}
	return pool;
}

/** 已用尽的名称池——直接缓存，避免重复计算 */
let _cachedPool: string[] | null = null;
export function getNamePool(): string[] {
	if (!_cachedPool) _cachedPool = generateNamePool();
	return _cachedPool;
}

/** 从已有名称判断所属星座 */
export function constellationOf(name: string): string | null {
	const match = name.match(/^([A-Za-z]+)-/);
	if (!match) return null;
	const cons = match[1];
	return STAR_NAMES.find((e) => e.constellation === cons)?.constellation || null;
}
