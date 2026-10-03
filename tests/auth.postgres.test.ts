import { describe } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "@/packages/db/client";
import { userSessions } from "@/packages/db/schema";
import { setAuthRepository } from "@/packages/repository/drizzle/auth.repository";
import { defineAuthFlowTests } from "./helpers/auth-flow";

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

	defineAuthFlowTests("email auth over HTTP (real Postgres)", {
		install: () => setAuthRepository(null),
		backdateRotation: async (sessionId) => {
			await db
				.update(userSessions)
				.set({ refreshRotatedAt: new Date(Date.now() - 10 * 60_000) })
				.where(eq(userSessions.id, sessionId));
		},
		expireSession: async (sessionId) => {
			await db
				.update(userSessions)
				.set({ expiresAt: new Date(Date.now() - 1_000) })
				.where(eq(userSessions.id, sessionId));
		},
	});
} else {
	describe.skip("email auth over HTTP (real Postgres) - set TEST_DATABASE_URL to run", () => {});
}
