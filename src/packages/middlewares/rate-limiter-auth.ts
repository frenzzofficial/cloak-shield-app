import { Elysia } from "elysia";

import { AppError } from "../utils/errors";

type MinimalRequestContext = {
	headers: Record<string, string | undefined>;
};

type RateLimiterOptions = {
	/** Redis key prefix and in-memory namespace. */
	prefix: string;

	/** Identifies who is being rate limited. */
	keyFn: (context: MinimalRequestContext) => string | Promise<string>;

	/** Maximum number of requests allowed in the window. */
	max: number;

	/** Rate-limit window in seconds. */
	windowSeconds: number;

	/** Message returned when the limit is exceeded. */
	message?: string;
};

type RateLimitEntry = {
	count: number;
	resetAt: number;
};

const defaultIpKey = (context: MinimalRequestContext): string =>
	context.headers["cf-connecting-ip"] ??
	context.headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
	context.headers["x-real-ip"] ??
	"unknown";

export const createRateLimiter = (options: RateLimiterOptions): Elysia => {
	const { prefix, keyFn, max, windowSeconds, message } = options;

	const windowMs = windowSeconds * 1_000;

	const memoryStore = new Map<string, RateLimitEntry>();

	const checkMemoryLimit = (key: string): boolean => {
		const now = Date.now();
		const storeKey = `${prefix}:${key}`;

		const entry = memoryStore.get(storeKey);

		if (!entry || now > entry.resetAt) {
			memoryStore.set(storeKey, {
				count: 1,
				resetAt: now + windowMs,
			});

			return true;
		}

		if (entry.count >= max) {
			return false;
		}

		entry.count += 1;

		return true;
	};

	return new Elysia({
		name: `rate-limiter:${prefix}`,
	}).onBeforeHandle({ as: "scoped" }, async (context) => {
		const key = await keyFn(context);

		const allowed = checkMemoryLimit(key);

		if (!allowed) {
			throw AppError.tooManyRequests(message ?? "Too many requests, please try again later");
		}
	});
};

export const rateLimiter = createRateLimiter({
	prefix: "ip",
	keyFn: defaultIpKey,
	max: 10,
	windowSeconds: 15 * 60,
});
