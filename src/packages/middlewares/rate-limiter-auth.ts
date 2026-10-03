import { envAppConfig } from "@/packages/env/app.env";
import { getClientIp } from "@/packages/utils/client-ip";
import { AppError } from "@/packages/utils/errors";

// Per-route rate limits for the sensitive auth endpoints. They are plain `beforeHandle`
// functions (not plugins) so each route picks the limiter that fits it.
//
// Storage is an in-process Map. That is exact on a single long-lived server, but on a
// serverless platform every instance counts separately, so treat these limits as a speed bump
// per instance rather than a global quota. The real brute-force defense is the per-account
// lockout, which lives in the database and is shared by every instance. If you need global
// quotas, back `createRateLimiter` with Redis (ENABLE_REDIS is already a flag).

export interface RateLimitContext {
	request: Request;
	server: Bun.Server<unknown> | null;
}

export interface RateLimiterOptions {
	/** Namespace so different limiters never share counters. */
	prefix: string;
	/** Requests allowed per window. */
	max: number;
	/** Window length in seconds. */
	windowSeconds: number;
	message?: string;
	/** Derives the bucket key. Defaults to the client IP (see TRUST_PROXY). */
	keyFn?: (context: RateLimitContext) => string;
}

interface Entry {
	count: number;
	resetAt: number;
}

const MAX_TRACKED_KEYS = 50_000;

const defaultKey = ({ request, server }: RateLimitContext): string =>
	getClientIp(request, server?.requestIP(request)?.address, envAppConfig.TRUST_PROXY);

export const createRateLimiter = (options: RateLimiterOptions) => {
	const { prefix, max, windowSeconds, message, keyFn = defaultKey } = options;
	const windowMs = windowSeconds * 1_000;
	const store = new Map<string, Entry>();
	let lastSweep = Date.now();

	// Expired entries are normally replaced when their key returns, but a key that never
	// comes back would sit in the Map forever. Sweep at most once per window.
	const sweep = (now: number): void => {
		if (now - lastSweep < windowMs && store.size < MAX_TRACKED_KEYS) return;
		lastSweep = now;

		for (const [key, entry] of store) {
			if (entry.resetAt <= now) store.delete(key);
		}

		// Still full of live entries (a flood of unique keys): drop the oldest to bound memory.
		while (store.size >= MAX_TRACKED_KEYS) {
			const oldest = store.keys().next().value;
			if (oldest === undefined) break;
			store.delete(oldest);
		}
	};

	return (context: RateLimitContext): void => {
		const now = Date.now();
		sweep(now);

		const key = `${prefix}:${keyFn(context)}`;
		const entry = store.get(key);

		if (!entry || entry.resetAt <= now) {
			store.set(key, { count: 1, resetAt: now + windowMs });
			return;
		}

		if (entry.count >= max) {
			throw AppError.tooManyRequests(message);
		}

		entry.count += 1;
	};
};

const noop = (): void => undefined;

const limiter = (options: RateLimiterOptions) =>
	envAppConfig.ENABLE_RATE_LIMIT ? createRateLimiter(options) : noop;

/** Sign-up and sign-in: the endpoints password guessing and account creation go through. */
export const credentialsLimiter = limiter({
	prefix: "auth-credentials",
	max: 10,
	windowSeconds: 15 * 60,
});

/** Refresh is called automatically by clients, so it gets more headroom. */
export const refreshLimiter = limiter({
	prefix: "auth-refresh",
	max: 60,
	windowSeconds: 15 * 60,
});

/** Verification / password-reset emails: stop the API being used to spam an inbox. */
export const emailActionLimiter = limiter({
	prefix: "auth-email-actions",
	max: 5,
	windowSeconds: 15 * 60,
});

/** Re-authenticated actions (change password / email, delete account, session control). */
export const accountActionLimiter = limiter({
	prefix: "account-actions",
	max: 20,
	windowSeconds: 15 * 60,
});
