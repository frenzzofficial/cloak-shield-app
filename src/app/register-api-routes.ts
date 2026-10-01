import type { Elysia } from "elysia";

import { appConfig } from "../packages/configs/app.config";

// Every versioned route is registered under a single `.group()`, e.g. /api/v1/... .
// Root-level routes that shouldn't be versioned (/, /health) stay outside this group —
// see routes.ts.
//
// Adding a new module: chain another `group.use(...)` (or `group.get(...)`, etc.) inside
// the callback below. A future v2 becomes a second `.group()` with its own prefix,
// registered independently — existing v1 routes and clients are unaffected.
//
// NOTE: the callback is a single-expression arrow that returns the chain directly (the
// pattern used in Elysia's own docs), not a separately-typed helper function — an explicit
// `Elysia` return type annotation on an intermediate function causes a generic mismatch
// (the same issue worked around in src/index.ts for the same underlying reason).
export const registerApiRoutes = (app: Elysia): void => {
	app.group(appConfig.api.base, (group) =>
		group.get(
			"/",
			({ status }) =>
				status(200, {
					version: appConfig.app.apiVersion,
					message: "Cloak Shield API",
				}),
			{
				detail: {
					tags: ["API"],
					summary: "API version info",
					description: "Confirms the API is reachable and reports its version.",
				},
			},
		),
	);
};
