import { cors } from "@elysiajs/cors";
import type { Elysia } from "elysia";

import { envAppConfig } from "../env/app.env";
import { envClientConfig } from "../env/client.env";

// Allowlists CLIENT_ORIGINS (comma-separated in .env, already parsed + validated as URLs —
// see env/client.env.ts). `credentials: true` because CSRF protection relies on a cookie
// (see middlewares/csrf.ts); a browser won't send or read that cookie cross-origin unless
// both this and the frontend's own `fetch(..., { credentials: "include" })` allow it.
//
// Register this early, before any route, so preflight (OPTIONS) requests are answered
// before hitting the rate limiter or CSRF check.
export const registerCors = (app: Elysia): void => {
	if (!envAppConfig.ENABLE_CORS) return;

	app.use(
		cors({
			origin: envClientConfig.CLIENT_ORIGINS,
			credentials: true,
			methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			allowedHeaders: ["Content-Type", "Authorization", "x-csrf-token"],
		}),
	);
};
