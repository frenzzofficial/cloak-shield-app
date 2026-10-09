import type { Elysia } from "elysia";

import { envAppConfig } from "../env/app.env";
import { logger } from "../utils/logger";

// Logs one line per request: method, path, status and duration. Uses the same JSON logger
// as everything else (utils/logger.ts), so these lines are structured the same way as
// error logs and go to stdout (or stderr for 5xx — see below).
//
// The start time is captured with `onRequest` into a WeakMap keyed by the Request object,
// not `derive` — `derive` runs too late to catch requests rejected earlier in the
// lifecycle (by the rate limiter or body limit, both `onRequest`-stage themselves), which
// would otherwise log `durationMs: null` for exactly the requests you'd most want timed.
// This must be registered before those two so its `onRequest` hook runs first and captures
// the true start time — see the registration order in app/main.ts.
const requestStartTimes = new WeakMap<Request, number>();

export const registerRequestLogging = (app: Elysia): void => {
	if (!envAppConfig.ENABLE_REQUEST_LOGGING) return;

	app.onRequest(({ request }) => {
		requestStartTimes.set(request, performance.now());
	}).onAfterResponse({ as: "global" }, ({ request, set }) => {
		const { pathname } = new URL(request.url);
		const startedAt = requestStartTimes.get(request);
		requestStartTimes.delete(request);
		const durationMs =
			startedAt === undefined ? null : Math.round(performance.now() - startedAt);
		const status = typeof set.status === "number" ? set.status : 200;

		const fields = { method: request.method, path: pathname, status, durationMs };
		if (status >= 500) logger.error("request", fields);
		else logger.info("request", fields);
	});
};
