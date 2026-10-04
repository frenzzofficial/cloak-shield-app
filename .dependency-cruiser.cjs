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
		// ── Sign-in plugins (src/app/auth) ──────────────────────────────────────────────
		// What keeps email / Google / Discord separable: each plugin may use core/ and packages/,
		// and nothing else in the auth tree. See src/app/auth/core/plugin.ts.
		{
			name: "auth-plugins-are-independent",
			comment:
				"a sign-in plugin must not import another plugin; share code through auth/core",
			severity: "error",
			from: { path: "^src/app/auth/(email|google|discord|phone)/" },
			to: {
				path: "^src/app/auth/(email|google|discord|phone)/",
				pathNot: "^src/app/auth/$1/",
			},
		},
		{
			name: "auth-core-must-not-import-plugins",
			comment: "core is the shared kernel; if it knew about a plugin it could not be removed",
			severity: "error",
			from: { path: "^src/app/auth/core/" },
			to: { path: "^src/app/auth/(email|google|discord|phone)/" },
		},
		{
			name: "outside-auth-use-core-not-plugins",
			comment:
				"other features (account, ...) depend on auth/core; only auth/plugins.ts may name a plugin",
			severity: "error",
			from: {
				path: "^src/app/",
				pathNot: "^src/app/auth/((email|google|discord|phone)/|plugins\\.ts$)",
			},
			to: { path: "^src/app/auth/(email|google|discord|phone)/" },
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
