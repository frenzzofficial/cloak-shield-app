import type { Elysia } from "elysia";

import { envAppConfig } from "../env/app.env";
import { AppError } from "../utils/errors";

// Hand-written fixed-window rate limiter, keyed by client IP. No dependency — the two
// published elysia-rate-limit-style packages have caused real trouble across different
// machines/Bun versions (one genuinely doesn't load against this Elysia version; the
// other loads fine in some environments but runs different code than what's actually
// published under the pinned version in others, calling an old two-argument
// `.beforeHandle(scope, handler)` form that no longer exists — see git history/PR
// discussion for the exact error). A ~40-line fixed-window counter is simple enough to
// not need a dependency, and removes that whole class of problem.
//
// Register this before routes so it applies globally, and after the error handler so a
// 429 still goes through the same JSON error shape as everything else.
//
// Fixed window (not sliding): a client can burst up to 2x max right at a window boundary.
// That trade-off is deliberate — it's O(1) per request with a plain Map, no timers, no
// external store. Good enough for a single-instance deployment; swap in Redis-backed
// counting (ENABLE_REDIS already exists as a flag) if this ever runs multi-instance.
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Bounds how large `buckets` can grow between windows, so a flood of unique IPs (or the
// "unknown" fallback key, under bun:test's in-process .handle() calls with no real
// server) can't leak memory. Oldest entries are dropped first once the cap is hit.
const MAX_TRACKED_CLIENTS = 50_000;

const getClientKey = (request: Request, server: Bun.Server<unknown> | null): string =>
	server?.requestIP(request)?.address ?? "unknown";

export const registerRateLimiter = (app: Elysia): void => {
	if (!envAppConfig.ENABLE_RATE_LIMIT) return;

	const windowMs = envAppConfig.RATE_LIMIT_WINDOW_MS;
	const max = envAppConfig.RATE_LIMIT_MAX_REQUESTS;

	app.onRequest(({ request, server, set }) => {
		const key = getClientKey(request, server);
		const now = Date.now();

		let bucket = buckets.get(key);
		if (!bucket || bucket.resetAt <= now) {
			if (buckets.size >= MAX_TRACKED_CLIENTS) {
				const oldestKey = buckets.keys().next().value;
				if (oldestKey !== undefined) buckets.delete(oldestKey);
			}
			bucket = { count: 0, resetAt: now + windowMs };
			buckets.set(key, bucket);
		}

		bucket.count += 1;

		const remaining = Math.max(0, max - bucket.count);
		set.headers["ratelimit-limit"] = String(max);
		set.headers["ratelimit-remaining"] = String(remaining);
		set.headers["ratelimit-reset"] = String(Math.ceil((bucket.resetAt - now) / 1000));

		if (bucket.count > max) {
			set.headers["retry-after"] = String(Math.ceil((bucket.resetAt - now) / 1000));
			throw AppError.tooManyRequests();
		}
	});
};
