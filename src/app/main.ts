import { Elysia } from "elysia";
import { registerBodyLimit } from "../packages/middlewares/body-limit";
import { registerCompression } from "../packages/middlewares/compression";
import { registerCors } from "../packages/middlewares/cors";
import { registerCsrfProtection } from "../packages/middlewares/csrf";
import { registerErrorHandler } from "../packages/middlewares/error-handler";
import { registerNotFound } from "../packages/middlewares/not-found";
import { registerRateLimiter } from "../packages/middlewares/rate-limiter";
import { registerRequestLogging } from "../packages/middlewares/request-logging";
import { registerSecurityHeaders } from "../packages/middlewares/security-headers";
import { registerBootstrap } from "./routes";

export const createApp = (): Elysia => {
	const app = new Elysia({
		name: "api",
	});

	// Order matters: each of these only affects routes registered AFTER it.

	// 1. Error handler first, so every failure below (including from the other
	//    middlewares) comes back as the standard JSON error shape.
	registerErrorHandler(app);

	// 2. Headers/limits/guards that should apply to every request, before any route runs.
	registerSecurityHeaders(app);
	registerCors(app);
	registerCompression(app);
	registerRequestLogging(app);
	registerBodyLimit(app);
	registerRateLimiter(app);
	registerCsrfProtection(app);

	// 3. Routes. Unversioned first (/, /health), then the versioned API group.
	registerBootstrap(app);

	// 4. Catch-all for anything unmatched. Must be LAST.
	registerNotFound(app);

	return app;
};
