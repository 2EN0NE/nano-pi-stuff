/**
 * permission-gate 动态策略 — Vitest 单元测试
 *
 * 测试 config.ts 中导出的纯函数：
 *   - makeCommandKey / makeToolKey / makeFolderKey
 *   - deepMerge（配置合并）
 *   - resolveConfigPath
 *   - getDefaultConfig
 */

import { describe, it, expect } from 'vitest';
import {
	makeCommandKey,
	makeToolKey,
	makeFolderKey,
	deepMerge,
	getDefaultConfig,
	resolveConfigPath,
} from '../../../extensions/security/permission-gate/config';
import type { PermissionGateConfig } from '../../../extensions/security/permission-gate/config';
import { getStrategySummary } from '../../../extensions/security/permission-gate/records';
import { buildStrategyItems } from '../../../extensions/security/permission-gate/two-tab-panel';

// ============================================================================
// makeCommandKey
// ============================================================================
describe('makeCommandKey', () => {
	it('generates deterministic keys for same command', () => {
		const k1 = makeCommandKey('rm -rf /tmp/test');
		const k2 = makeCommandKey('rm -rf /tmp/test');
		expect(k1).toBe(k2);
		expect(k1).toMatch(/^cmd:[a-f0-9]{16}$/);
	});

	it('normalizes whitespace', () => {
		const k1 = makeCommandKey('rm  -rf   /tmp/test');
		const k2 = makeCommandKey('rm -rf /tmp/test');
		expect(k1).toBe(k2);
	});

	it('generates different keys for different commands', () => {
		const k1 = makeCommandKey('rm -rf /tmp/a');
		const k2 = makeCommandKey('rm -rf /tmp/b');
		expect(k1).not.toBe(k2);
	});
});

// ============================================================================
// makeToolKey
// ============================================================================
describe('makeToolKey', () => {
	it('generates tool: prefix keys', () => {
		expect(makeToolKey('rm')).toBe('tool:rm');
		expect(makeToolKey('sudo')).toBe('tool:sudo');
	});
});

// ============================================================================
// makeFolderKey
// ============================================================================
describe('makeFolderKey', () => {
	it('generates dir: prefix keys', () => {
		expect(makeFolderKey('/tmp/test')).toBe('dir:/tmp/test');
	});

	it('strips trailing slashes', () => {
		expect(makeFolderKey('/tmp/test/')).toBe('dir:/tmp/test');
		expect(makeFolderKey('/tmp/test//')).toBe('dir:/tmp/test');
	});
});

// ============================================================================
// deepMerge
// ============================================================================
describe('deepMerge', () => {
	it('merges dynamic policy thresholds', () => {
		const base = getDefaultConfig();
		// 注意：deepMerge 对 dynamicPolicy.thresholds 使用 ??，仅覆盖显式提供的字段
		const overrides = {
			dynamicPolicyEnabled: true,
			dynamicPolicy: {
				scope: '/custom',
				thresholds: {
					sameCommand: 5,
				},
			},
		} as Partial<PermissionGateConfig>;
		const merged = deepMerge(base, overrides);
		expect(merged.dynamicPolicyEnabled).toBe(true);
		expect(merged.dynamicPolicy.scope).toBe('/custom');
		expect(merged.dynamicPolicy.thresholds.sameCommand).toBe(5);
		// 未覆盖的阈值保持默认
		expect(merged.dynamicPolicy.thresholds.sameTool).toBe(
			base.dynamicPolicy.thresholds.sameTool,
		);
		expect(merged.dynamicPolicy.thresholds.sameFolder).toBe(
			base.dynamicPolicy.thresholds.sameFolder,
		);
	});

	it('overrides patterns (not concat)', () => {
		const base = getDefaultConfig();
		const overrides: Partial<PermissionGateConfig> = {
			patterns: ['\\brm\\s'],
		};
		const merged = deepMerge(base, overrides);
		expect(merged.patterns).toEqual(['\\brm\\s']);
	});

	it('keeps enabled when not overridden', () => {
		const base: PermissionGateConfig = {
			...getDefaultConfig(),
			enabled: true,
		};
		const merged = deepMerge(base, {});
		expect(merged.enabled).toBe(true);
	});
});

// ============================================================================
// getDefaultConfig
// ============================================================================
describe('getDefaultConfig', () => {
	it('returns a valid config', () => {
		const config = getDefaultConfig();
		expect(config.enabled).toBe(true);
		expect(config.dynamicPolicyEnabled).toBe(false);
		expect(config.patterns.length).toBeGreaterThan(0);
		expect(config.dynamicPolicy.thresholds.sameCommand).toBe(2);
		expect(config.dynamicPolicy.thresholds.sameTool).toBe(3);
		expect(config.dynamicPolicy.thresholds.sameFolder).toBe(4);
		expect(config.dynamicPolicy.scope).toBe('.');
	});

	it('has dangerous patterns that match expected commands', () => {
		const config = getDefaultConfig();
		const checkMatch = (pattern: string, cmd: string): boolean => {
			return new RegExp(pattern, 'i').test(cmd);
		};
		expect(config.patterns.some((p) => checkMatch(p, 'rm -rf /tmp/x'))).toBe(true);
		expect(config.patterns.some((p) => checkMatch(p, 'sudo rm -rf /'))).toBe(true);
		expect(config.patterns.some((p) => checkMatch(p, 'eval ls'))).toBe(true);
		expect(config.patterns.some((p) => checkMatch(p, 'chmod +x file'))).toBe(true);
	});
});

// ============================================================================
// resolveConfigPath
// ============================================================================
describe('resolveConfigPath', () => {
	it('resolves project config path', () => {
		const path = resolveConfigPath('/my/project', 'project');
		expect(path).toContain('.pi/extensions-data/permission-gate/config.json');
		expect(path).toContain('/my/project');
	});

	it('resolves user config path', () => {
		const path = resolveConfigPath('/any/cwd', 'user');
		expect(path).toContain('/.pi/agent/extensions-data/permission-gate/config.json');
	});
});

// ============================================================================
// getStrategySummary
// ============================================================================
describe('getStrategySummary', () => {
	const thresholds = { sameCommand: 2, sameTool: 3, sameFolder: 4 };

	it('returns all zeros for empty counts', () => {
		const s = getStrategySummary({}, thresholds);
		expect(s).toEqual({
			cmd: { total: 0, active: 0 },
			tool: { total: 0, active: 0 },
			dir: { total: 0, active: 0 },
		});
	});

	it('counts cmd keys correctly (2 total, 1 active)', () => {
		const counts = {
			'cmd:abc123': 1, // 1 < 2 → active
			'cmd:def456': 2, // 2 >= 2 → not active
		};
		const s = getStrategySummary(counts, thresholds);
		expect(s.cmd).toEqual({ total: 2, active: 1 });
		expect(s.tool).toEqual({ total: 0, active: 0 });
		expect(s.dir).toEqual({ total: 0, active: 0 });
	});

	it('counts tool keys correctly', () => {
		const counts = {
			'tool:rm': 1, // 1 < 3 → active
			'tool:sudo': 3, // 3 >= 3 → not active
			'tool:chmod': 5, // 5 >= 3 → not active
		};
		const s = getStrategySummary(counts, thresholds);
		expect(s.tool).toEqual({ total: 3, active: 1 });
	});

	it('counts dir keys correctly', () => {
		const counts = {
			'dir:/tmp': 2, // 2 < 4 → active
			'dir:/home': 4, // 4 >= 4 → not active
		};
		const s = getStrategySummary(counts, thresholds);
		expect(s.dir).toEqual({ total: 2, active: 1 });
	});

	it('handles mixed dimensions', () => {
		const counts = {
			'cmd:abc': 0,
			'cmd:def': 1,
			'tool:rm': 2,
			'dir:/tmp': 3,
		};
		const s = getStrategySummary(counts, thresholds);
		expect(s.cmd).toEqual({ total: 2, active: 2 }); // 0<2, 1<2
		expect(s.tool).toEqual({ total: 1, active: 1 }); // 2<3
		expect(s.dir).toEqual({ total: 1, active: 1 }); // 3<4
	});
});

// ============================================================================
// buildStrategyItems
// ============================================================================
describe('buildStrategyItems', () => {
	const thresholds = { sameCommand: 2, sameTool: 3, sameFolder: 4 };

	it('returns empty array for empty counts', () => {
		const items = buildStrategyItems({}, thresholds);
		expect(items).toEqual([]);
	});

	it('builds items with correct dimension labels', () => {
		const counts = {
			'cmd:abc123': 1,
			'tool:rm': 2,
			'dir:/tmp': 3,
		};
		const items = buildStrategyItems(counts, thresholds);
		expect(items).toHaveLength(3);

		expect(items[0]).toMatchObject({
			dimension: 'cmd',
			key: 'cmd:abc123',
			displayKey: 'abc123',
			count: 1,
			threshold: 2,
			isActive: true,
		});
		expect(items[1]).toMatchObject({
			dimension: 'tool',
			key: 'tool:rm',
			displayKey: 'rm',
			count: 2,
			threshold: 3,
			isActive: true,
		});
		expect(items[2]).toMatchObject({
			dimension: 'dir',
			key: 'dir:/tmp',
			displayKey: '/tmp',
			count: 3,
			threshold: 4,
			isActive: true,
		});
	});

	it('marks items at threshold as inactive', () => {
		const counts = {
			'cmd:full': 2, // exactly at threshold → NOT active
		};
		const items = buildStrategyItems(counts, thresholds);
		expect(items[0]).toMatchObject({
			isActive: false,
			count: 2,
			threshold: 2,
		});
	});
});
