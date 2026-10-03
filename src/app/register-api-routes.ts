import type { Elysia } from "elysia";

import { appConfig } from "@/packages/configs/app.config";
import { envAppConfig } from "@/packages/env/app.env";
import { CSRF_COOKIE_NAME } from "@/packages/middlewares/csrf";

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

	// A frontend on another origin cannot read this API's cookies, so it fetches the CSRF token
	// here (cross-origin reads are protected by the CORS allowlist) and echoes it back in the
	// `x-csrf-token` header on every state-changing request.
	if (envAppConfig.ENABLE_CSRF_PROTECTION) {
		app.get(
			appConfig.auth.csrfToken,
			({ cookie, status }) =>
				status(200, { success: true, csrfToken: cookie[CSRF_COOKIE_NAME]?.value }),
			{
				detail: {
					tags: ["Auth"],
					summary: "CSRF token",
					description:
						"Returns the CSRF token to send as x-csrf-token on POST/PUT/PATCH/DELETE requests.",
				},
			},
		);
	}
};
