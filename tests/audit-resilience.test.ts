import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../src/app/main";
import { getMailer, type MailMessage, setMailer } from "../src/packages/mailer/mailer";
import { setAuthRepository } from "../src/packages/repository/drizzle/auth.repository";
import type { AuditLogRecord } from "../src/packages/schema/user.schema";
import { BASE, newEmail, PASSWORD } from "./helpers/auth-flow";
import { pick, TestClient } from "./helpers/http";
import { InMemoryAuthRepository } from "./helpers/memory-repo";

// The audit trail and the mail provider are side effects. If either breaks, signing in must
// still work: failing a login because a log row could not be written would turn a minor
// outage into a full one.
class BrokenAuditRepository extends InMemoryAuthRepository {
	override async createAuditLog(_entry: AuditLogRecord): Promise<void> {
		throw new Error("audit table is down");
	}
}

describe("side effects never break the main request", () => {
	const app = createApp();

	// Process-wide singletons: put them back so other test files are unaffected.
	const originalMailer = getMailer();

	beforeAll(() => {
		setAuthRepository(new BrokenAuditRepository());
		setMailer({
			send: async (_message: MailMessage) => {
				throw new Error("mail provider is down");
			},
		});
	});

	afterAll(() => {
		setAuthRepository(null);
		setMailer(originalMailer);
	});

	test("sign-up, sign-in, password change and sign-out succeed with audit and mail both down", async () => {
		const client = new TestClient(app);
		const email = newEmail();

		const created = await client.post(`${BASE}/signup`, {
			json: { fullname: "Test User", email, password: PASSWORD },
		});
		expect(created.status).toBe(201);

		const other = new TestClient(app);
		expect(
			(await other.post(`${BASE}/signin`, { json: { email, password: PASSWORD } })).status,
		).toBe(200);

		const changed = await client.post(`${BASE}/change-password`, {
			json: {
				currentPassword: PASSWORD,
				newPassword: "Another-Horse-7-Staple!",
				confirmPassword: "Another-Horse-7-Staple!",
			},
		});
		expect(changed.status).toBe(200);
		expect(pick(changed.body, "revokedSessions")).toBe(1);

		expect((await client.post(`${BASE}/signout`)).status).toBe(200);
	});
});
