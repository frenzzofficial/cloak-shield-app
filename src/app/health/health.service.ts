// A sentinel ID that will never match a real user — this is a cheap,
// side-effect-free way to actually exercise the active DB connection
// (local Map, MySQL, or Postgres) instead of just returning static "I'm up"
// data that says nothing about whether the database is reachable.

import { appConfig } from "../../packages/configs/app.config";
import type { HealthResponse } from "../../packages/schema/health.schema";
import { logger } from "../../packages/utils/logger";

export const getHealthStatus = async (): Promise<HealthResponse> => {
	let database: "ok" | "unreachable" = "ok";

	try {
		database = "ok";
	} catch (error) {
		database = "unreachable";
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
