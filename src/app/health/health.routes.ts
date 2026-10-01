import type Elysia from "elysia";
import type { Context } from "elysia";
import { appConfig } from "../../packages/configs/app.config";
import type { HealthResponse } from "../../packages/schema/health.schema";
import { ok } from "../../packages/utils/response";
import { getHealthStatus } from "./health.service";

const handleHealthCheck = async (c: Context) => {
	const health = (await getHealthStatus()) as HealthResponse;
	// 503 when the DB is unreachable — this is what actually lets load
	// balancers / uptime monitors distinguish "app is up" from "app is up
	// but can't serve real requests," which a static 200 never could.
	return ok(c, health, health.status === "ok" ? 200 : 503);
};

const healthRouteDetail = {
	tags: ["Health"],
	summary: "Health check",
	description: "Reports service status, uptime and database connectivity.",
};

export const registerHealthRoutes = (app: Elysia): void => {
	app.get("/health", handleHealthCheck, { detail: healthRouteDetail });
	app.get(`${appConfig.app.apiPrefix}/health`, handleHealthCheck, { detail: healthRouteDetail });
};
