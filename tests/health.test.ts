import { describe, expect, test } from "bun:test";

import { getHealthStatus } from "@/app/health/health.service";

describe("health check", () => {
	test("is ok when the database answers", async () => {
		const health = await getHealthStatus(async () => undefined);

		expect(health.status).toBe("ok");
		expect(health.database).toBe("ok");
	});

	test("is degraded when the query fails, without leaking the error", async () => {
		const health = await getHealthStatus(async () => {
			throw new Error("password authentication failed for user postgres");
		});

		expect(health.status).toBe("degraded");
		expect(health.database).toBe("unreachable");
		expect(JSON.stringify(health)).not.toContain("password authentication");
	});

	test("treats a synchronous throw (e.g. DATABASE_URL missing) the same way", async () => {
		const health = await getHealthStatus(() => {
			throw new Error("DATABASE_URL is not set");
		});

		expect(health.database).toBe("unreachable");
	});

	test("gives up on a hung database instead of hanging the probe", async () => {
		const started = Date.now();
		const health = await getHealthStatus(() => new Promise<void>(() => undefined), 40);

		expect(health.database).toBe("unreachable");
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
