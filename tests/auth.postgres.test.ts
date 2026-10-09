import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { db } from "../src/packages/db/client";
import { auditLogs, userSessions } from "../src/packages/db/schema";
import {
	getAuthRepository,
	setAuthRepository,
} from "../src/packages/repository/drizzle/auth.repository";
import { defineAccountFlowTests } from "./helpers/account-flow";
import { defineAuthFlowTests } from "./helpers/auth-flow";
import { defineGoogleFlowTests } from "./helpers/google-flow";
import { pick } from "./helpers/http";
import { defineIdentityTests } from "./helpers/identity-flow";

// Runs the same HTTP flow suite against a real Postgres, which is the only way to check the SQL
// (atomic lockout counter, compare-and-swap rotation, single-use tokens, unique constraints).
//
//   bun run db:push                      # with DATABASE_URL pointing at a THROWAWAY database
//   TEST_DATABASE_URL=<same url> bun test tests/auth.postgres.test.ts
//
// Skipped when TEST_DATABASE_URL is not set, so a plain `bun test` needs no database.
const url = process.env.TEST_DATABASE_URL;

if (url) {
	process.env.DATABASE_URL = url;

	const backend = {
		install: () => setAuthRepository(null),
		backdateRotation: async (sessionId: string) => {
			await db
				.update(userSessions)
				.set({ refreshRotatedAt: new Date(Date.now() - 10 * 60_000) })
				.where(eq(userSessions.id, sessionId));
		},
		expireSession: async (sessionId: string) => {
			await db
				.update(userSessions)
				.set({ expiresAt: new Date(Date.now() - 1_000) })
				.where(eq(userSessions.id, sessionId));
		},
		auditDump: async () => JSON.stringify(await db.select().from(auditLogs)),
		auditEventsForSubject: async (subjectId: string) =>
			(await db.select().from(auditLogs).where(eq(auditLogs.subjectId, subjectId))).map(
				(row) => row.event,
			),
		wipeAudit: async (userId: string) => {
			await db.delete(auditLogs).where(eq(auditLogs.userId, userId));
		},
	};

	describe("postgres specifics", () => {
		test("audit metadata is stored as a real jsonb object, not a JSON string", async () => {
			setAuthRepository(null);
			const id = crypto.randomUUID();

			await getAuthRepository().createAuditLog({
				id,
				userId: null,
				subjectId: null,
				event: "SIGN_IN_SUCCESS",
				outcome: "SUCCESS",
				ipAddress: "",
				userAgent: "",
				metadata: { deviceName: "Chrome on Windows", nested: { ok: true } },
				createdAt: new Date(),
			});

			const rows: unknown = await db.execute(
				sql`select jsonb_typeof(metadata) as kind, metadata->>'deviceName' as device from audit_logs where id = ${id}`,
			);
			expect(pick(rows, "0.kind")).toBe("object");
			expect(pick(rows, "0.device")).toBe("Chrome on Windows");
		});

		test("health reports the database as reachable", async () => {
			const { getHealthStatus } = await import("../src/app/health/health.service");
			const health = await getHealthStatus();
			expect(health.status).toBe("ok");
			expect(health.database).toBe("ok");
		});
	});

	defineAuthFlowTests("email auth over HTTP (real Postgres)", backend);
	defineAccountFlowTests("account security over HTTP (real Postgres)", backend);
	defineGoogleFlowTests("Google sign-in over HTTP (real Postgres)", {
		install: () => setAuthRepository(null),
		auditDump: async () => JSON.stringify(await db.select().from(auditLogs)),
	});
	defineIdentityTests("provider identities over the core (real Postgres)", {
		install: () => setAuthRepository(null),
		backdateSignIn: async (sessionId, to) => {
			await db
				.update(userSessions)
				.set({ createdAt: to })
				.where(eq(userSessions.id, sessionId));
		},
	});
} else {
	describe.skip("email auth over HTTP (real Postgres) - set TEST_DATABASE_URL to run", () => {});
}
