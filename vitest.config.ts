import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["test/unit/**/*.test.ts"],
				},
			},
			{
				test: {
					name: "e2e",
					include: ["test/e2e/**/*.test.ts"],
					exclude: ["test/e2e/.generated/**"],
					// builds dist/ so the CLI binary and the published entry point can be exercised
					globalSetup: ["test/e2e/global-setup.ts"],
					testTimeout: 60_000,
					hookTimeout: 180_000,
				},
			},
		],
	},
});
