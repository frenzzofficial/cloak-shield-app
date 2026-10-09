import { describe, expect, test } from "bun:test";

import {
	createRateLimiter,
	type RateLimitContext,
} from "../src/packages/middlewares/rate-limiter-auth";
import { AppError } from "../src/packages/utils/errors";

const context = (headers: Record<string, string> = {}): RateLimitContext => ({
	request: new Request("http://localhost/", { headers }),
	server: null,
});

const statusOf = (run: () => void): number | undefined => {
	try {
		run();
		return undefined;
	} catch (error) {
		return error instanceof AppError ? error.statusCode : -1;
	}
};

describe("createRateLimiter", () => {
	test("allows `max` requests then answers 429", () => {
		const limit = createRateLimiter({ prefix: "t1", max: 3, windowSeconds: 60 });
		const ctx = context();

		expect(statusOf(() => limit(ctx))).toBeUndefined();
		expect(statusOf(() => limit(ctx))).toBeUndefined();
		expect(statusOf(() => limit(ctx))).toBeUndefined();
		expect(statusOf(() => limit(ctx))).toBe(429);
	});

	test("rotating X-Forwarded-For does not buy a fresh allowance", () => {
		// The audit's reproduction: same socket, a new forged header on every request.
		const limit = createRateLimiter({ prefix: "t2", max: 2, windowSeconds: 60 });
		const results = Array.from({ length: 6 }, (_, index) =>
			statusOf(() => limit(context({ "x-forwarded-for": `9.9.9.${index}` }))),
		);

		expect(results.filter((status) => status === 429).length).toBe(4);
	});

	test("limiters with different prefixes never share counters", () => {
		const a = createRateLimiter({ prefix: "a", max: 1, windowSeconds: 60 });
		const b = createRateLimiter({ prefix: "b", max: 1, windowSeconds: 60 });
		const ctx = context();

		a(ctx);
		expect(statusOf(() => a(ctx))).toBe(429);
		expect(statusOf(() => b(ctx))).toBeUndefined();
	});

	test("a custom key function separates clients", () => {
		const limit = createRateLimiter({
			prefix: "t3",
			max: 1,
			windowSeconds: 60,
			keyFn: ({ request }) => request.headers.get("x-user") ?? "anon",
		});

		limit(context({ "x-user": "ann" }));
		expect(statusOf(() => limit(context({ "x-user": "ann" })))).toBe(429);
		expect(statusOf(() => limit(context({ "x-user": "bob" })))).toBeUndefined();
	});

	test("the window resets once it ends", async () => {
		const limit = createRateLimiter({ prefix: "t4", max: 1, windowSeconds: 0.05 });
		const ctx = context();

		limit(ctx);
		expect(statusOf(() => limit(ctx))).toBe(429);

		await Bun.sleep(80);
		expect(statusOf(() => limit(ctx))).toBeUndefined();
	});

	test("expired keys are swept rather than accumulating", async () => {
		const limit = createRateLimiter({
			prefix: "t6",
			max: 1,
			windowSeconds: 0.05,
			keyFn: ({ request }) => request.headers.get("x-key") ?? "none",
		});

		for (let index = 0; index < 50; index += 1) limit(context({ "x-key": `k${index}` }));
		await Bun.sleep(80);

		// Any call after the window triggers a sweep and must still behave correctly.
		expect(statusOf(() => limit(context({ "x-key": "k0" })))).toBeUndefined();
		expect(statusOf(() => limit(context({ "x-key": "k0" })))).toBe(429);
	});

	test("uses a custom message", () => {
		const limit = createRateLimiter({
			prefix: "t5",
			max: 1,
			windowSeconds: 60,
			message: "slow down",
		});
		const ctx = context();
		limit(ctx);

		try {
			limit(ctx);
		} catch (error) {
			expect(error instanceof AppError && error.message).toBe("slow down");
		}
	});
});
