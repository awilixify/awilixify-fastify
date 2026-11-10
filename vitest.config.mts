import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
	oxc: false,
	plugins: [
		swc.vite({
			jsc: {
				transform: { decoratorVersion: "2022-03" },
				parser: {
					syntax: "typescript",
					decorators: true,
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
