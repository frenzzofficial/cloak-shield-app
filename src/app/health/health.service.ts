import { sql } from "drizzle-orm";

import { appConfig } from "../../packages/configs/app.config";
import { db } from "../../packages/db/client";
import type { HealthResponse } from "../../packages/schema/health.schema";
import { logger } from "../../packages/utils/logger";

/** One cheap round trip: proves the connection works and the database answers. */
export type DatabasePing = () => Promise<void>;

const pingDatabase: DatabasePing = async () => {
	await db.execute(sql`select 1`);
};

const DEFAULT_TIMEOUT_MS = 2_500;

// A health probe that hangs is worse than one that fails: the load balancer waits, then gives up.
const withTimeout = async (task: Promise<unknown>, ms: number): Promise<void> => {
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		await Promise.race([
			task,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`database ping timed out after ${ms}ms`)),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};

export const getHealthStatus = async (
	ping: DatabasePing = pingDatabase,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HealthResponse> => {
	let database: "ok" | "unreachable" = "ok";

	try {
		// Wrapped in an async function so a synchronous throw (e.g. DATABASE_URL missing) is
		// handled the same way as a rejected query.
		await withTimeout((async () => ping())(), timeoutMs);
	} catch (error) {
		database = "unreachable";
		// Details go to the log only; the response never reveals connection errors.
		logger.error("health check: database unreachable", {
			errorMessage: error instanceof Error ? error.message : String(error),
		});
	}

	return {
		status: database === "ok" ? "ok" : "degraded",
		message:
			database === "ok" ? "Server is running" : "Server is running, database unreachable",
		timestamp: new Date().toISOString(),
		env: appConfig.app.NODE_ENV,
		database,
	};
};
