import type { Elysia } from "elysia";

import { registerOpenApi } from "@/packages/middlewares/openapi";
import { registerAccountRoutes } from "./account/account.routes";
import type { AuthPlugin } from "./auth/core/plugin";
import { registerAuthPlugins } from "./auth/plugins";
import { registerHealthRoutes } from "./health/health.routes";
import { registerApiRoutes } from "./register-api-routes";
import { registerStaticRoutes } from "./static/static.routes";

// This file (and register-api-routes.ts) lives under src/app, not src/packages — it's
// composition/wiring (deciding WHICH routes exist and in what order), the same job as
// main.ts, not a standalone feature. Route MODULES (health/, static/) also live under
// src/app for the same reason: they're specific to this one app, not reusable
// infrastructure. src/packages stays for cross-cutting code with no opinion about which
// routes exist — middlewares, config, env, shared utils — which is what
// `bun run arch`'s "packages-must-not-import-app" rule enforces: packages/* must never
// import from app/*, only the reverse.
export const registerBootstrap = (app: Elysia, authPlugins?: readonly AuthPlugin[]): void => {
	// ── Health check ──────────────────────────────────────────────────────────────
	registerHealthRoutes(app);

	// ── Static Routes (HTML, assets) ──────────────────────────────────────────────────────────────
	registerStaticRoutes(app);

	// ── OpenAPI docs — must come before the routes it documents.
	registerOpenApi(app);

	// ── Versioned API routes ──────────────────────────────────────────────────────────────
	registerApiRoutes(app);

	registerIdentityRoutes(app, authPlugins);
};

/**
 * Sign-in methods and everything that needs a signed-in user. Split out so "account routes exist
 * only when at least one way to sign in does" can be tested without touching process.env.
 */
export const registerIdentityRoutes = (app: Elysia, plugins?: readonly AuthPlugin[]): void => {
	const providers = registerAuthPlugins(app, plugins);

	// Profile, preferences and deletion need at least one way to sign in.
	if (providers.length > 0) registerAccountRoutes(app);
};
