import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/vitest/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/.pi/**', '**/results/**'],
		// e2e 测试可能耗时较长
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// CI 环境下输出 JUnit 格式
		...(process.env.CI
			? {
					reporter: ['default', 'junit'],
					outputFile: {
						junit: 'test/results/vitest-junit.xml',
					},
				}
			: {}),
	},
});
