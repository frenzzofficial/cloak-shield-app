/** Architecture rules for the src/packages layout: keep layers clean and the graph acyclic. */
module.exports = {
	forbidden: [
		{ name: "no-circular", severity: "error", from: {}, to: { circular: true } },
		{
			name: "packages-must-not-import-app",
			severity: "error",
			from: { path: "^src/packages" },
			to: { path: "^src/app" },
		},
		{
			name: "env-is-a-leaf-layer",
			comment:
				"env files may only depend on other env files, plus the generic parse-env helper",
			severity: "error",
			from: { path: "^src/packages/env" },
			to: {
				path: "^src/packages/(configs|middlewares|utils)",
				pathNot: "^src/packages/utils/parse-env\\.ts$",
			},
		},
		{
			name: "configs-only-depend-on-env",
			severity: "error",
			from: { path: "^src/packages/configs" },
			to: { path: "^src/packages/(middlewares|bootstrap|utils)" },
		},
		{
			name: "utils-must-not-import-features",
			severity: "error",
			from: { path: "^src/packages/utils" },
			to: { path: "^src/packages/(middlewares|bootstrap|configs)" },
		},
		{
			name: "no-orphans",
			severity: "warn",
			from: {
				orphan: true,
				pathNot: ["\\.d\\.ts$", "^src/index\\.ts$", "^src/app/server\\.ts$"],
			},
			to: {},
		},
	],
	options: {
		tsConfig: { fileName: "tsconfig.json" },
		doNotFollow: { path: "node_modules" },
		moduleSystems: ["es6", "cjs"],
	},
};
