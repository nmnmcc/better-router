import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**", "**/references/**"],
		testTimeout: 15_000,
		hookTimeout: 15_000,
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			reportsDirectory: "coverage",
			include: ["packages/*/dist/**/*.mjs"],
			exclude: [
				"**/dist/index.mjs",
				"**/dist/rolldown-runtime-*.mjs",
				"packages/core/dist/OpenResponses.mjs",
			],
		},
	},
})
