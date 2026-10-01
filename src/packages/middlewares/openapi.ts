import { openapi } from "@elysiajs/openapi";
import type { Elysia } from "elysia";

import { envAppConfig } from "../env/app.env";
import { envPublicConfig } from "../env/public.env";

// Auto-generates OpenAPI docs from route schemas and serves an interactive page.
// Must be registered BEFORE the routes it should document — it can only pick up schemas
// from routes defined after it in the chain.
//
// provider: "swagger-ui" — the classic Swagger UI look, served at /openapi. The plugin
// defaults to Scalar's UI instead; swap `provider` back to "scalar" (or drop it) if you'd
// rather have that.
export const registerOpenApi = (app: Elysia): void => {
	if (!envAppConfig.ENABLE_SWAGGER) return;

	app.use(
		openapi({
			path: "/openapi",
			provider: "swagger-ui",
			documentation: {
				info: {
					title: envPublicConfig.APP_NAME,
					version: envPublicConfig.APP_VERSION,
					description: envPublicConfig.APP_DESCRIPTION,
				},
				tags: [
					{ name: "Health", description: "Service and database health checks" },
					{ name: "API", description: "Versioned API endpoints" },
				],
			},
			// The HTML pages and static assets (/, /home, /docs, /assets/*) aren't part of the
			// JSON API — excluded so the spec only lists actual API endpoints.
			exclude: {
				paths: ["/", "/home", "/docs", "/*", /^\/assets\//],
			},
			swagger: {
				// Keeps operations collapsed by default so the page is scannable rather than a
				// long scroll of expanded schemas on first load.
				docExpansion: "list",
				persistAuthorization: true,
				// Swagger UI calls validator.swagger.io by default to show a little green/red
				// badge next to the spec version. That's an unnecessary external call for an
				// internal API doc page — turned off.
				validatorUrl: "none",
			},
		}),
	);
};
