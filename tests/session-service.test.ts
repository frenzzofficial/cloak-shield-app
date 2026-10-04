import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { DeviceInfo } from "@/app/auth/core/auth.types";
import { isBlocked, startSession } from "@/app/auth/core/session.service";
import { authConfig } from "@/packages/configs/auth.config";
import { getMailer, type MailMessage, setMailer } from "@/packages/mailer/mailer";
import { setAuthRepository } from "@/packages/repository/drizzle/auth.repository";
import type { User } from "@/packages/schema/user.schema";
import { InMemoryAuthRepository } from "./helpers/memory-repo";

const CHROME: DeviceInfo = {
	deviceName: "Chrome on Windows",
	platform: "desktop",
	browser: "Chrome",
	os: "Windows",
	ipAddress: "203.0.113.9",
	userAgent: "test-chrome",
};
const PHONE: DeviceInfo = {
	...CHROME,
	deviceName: "Safari on iOS",
	os: "iOS",
	userAgent: "test-phone",
};

const makeUser = (overrides: Partial<User> = {}): User => {
	const now = new Date();
	return {
		id: crypto.randomUUID(),
		fullname: null,
		email: `u-${crypto.randomUUID().slice(0, 8)}@example.com`,
		avatarUrl: null,
		role: "USER",
		status: "ACTIVE",
		emailVerifiedAt: now,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
};

describe("session service", () => {
	let memory: InMemoryAuthRepository;
	const outbox: MailMessage[] = [];
	const originalMailer = getMailer();

	beforeAll(() => {
		setMailer({
			send: async (message) => {
				outbox.push(message);
			},
		});
	});

	afterAll(() => {
		setAuthRepository(null);
		setMailer(originalMailer);
	});

	beforeEach(() => {
		memory = new InMemoryAuthRepository();
		setAuthRepository(memory);
		outbox.length = 0;
	});

	describe("isBlocked", () => {
		test("suspended and deactivated accounts are blocked, everyone else is not", () => {
			expect(isBlocked(makeUser({ status: "SUSPENDED" }))).toBe(true);
			expect(isBlocked(makeUser({ status: "DEACTIVATED" }))).toBe(true);
			expect(isBlocked(makeUser({ status: "ACTIVE" }))).toBe(false);
			expect(isBlocked(makeUser({ status: "PENDING_VERIFICATION" }))).toBe(false);
		});
	});

	describe("startSession", () => {
		test("remember picks the long session, otherwise the short one", async () => {
			const user = makeUser();

			const long = await startSession(user, CHROME, { remember: true });
			const short = await startSession(user, CHROME, { remember: false });

			const lifetime = (login: typeof long) =>
				(login.session.expiresAt.getTime() - login.session.createdAt.getTime()) / 1_000;
			expect(lifetime(long)).toBe(authConfig.longSessionTtlSeconds);
			expect(lifetime(short)).toBe(authConfig.shortSessionTtlSeconds);
		});

		test("stores the device on the session and returns usable tokens", async () => {
			const user = makeUser();
			const login = await startSession(user, PHONE, { remember: false });

			const stored = await memory.getSession(login.session.id);
			expect(stored?.deviceName).toBe("Safari on iOS");
			expect(stored?.userId).toBe(user.id);
			expect(stored?.refreshTokenId).toBeTruthy();
			expect(login.tokens.accessToken.split(".").length).toBe(3);
			expect(login.tokens.refreshToken.split(".").length).toBe(3);
		});

		test("keeps at most maxSessionsPerUser sessions and purges expired ones", async () => {
			const user = makeUser();

			const expired = await startSession(user, CHROME, { remember: false });
			memory.patchSession(expired.session.id, { expiresAt: new Date(Date.now() - 1_000) });

			for (let index = 0; index < authConfig.maxSessionsPerUser + 3; index += 1) {
				await startSession(user, CHROME, { remember: false });
			}

			const sessions = await memory.listSessionsForUser(user.id);
			expect(sessions.length).toBe(authConfig.maxSessionsPerUser);
			expect(sessions.some((session) => session.id === expired.session.id)).toBe(false);
		});

		test("the audit row carries remember plus whatever the caller adds", async () => {
			const user = makeUser();
			await startSession(user, CHROME, { remember: true, metadata: { provider: "google" } });

			const [row] = memory.allAuditLogs();
			expect(row?.event).toBe("SIGN_IN_SUCCESS");
			expect(row?.userId).toBe(user.id);
			expect(row?.ipAddress).toBe("203.0.113.9");
			expect(row?.metadata).toEqual({
				deviceName: "Chrome on Windows",
				remember: true,
				provider: "google",
			});
		});

		test("a plugin's metadata can add context but never overwrite core fields", async () => {
			const user = makeUser();
			await startSession(user, CHROME, { remember: true, metadata: { remember: false } });

			expect(memory.allAuditLogs()[0]?.metadata.remember).toBe(true);
		});

		test("warns about a new device, but only for confirmed accounts with history", async () => {
			const user = makeUser();

			await startSession(user, CHROME, { remember: false });
			expect(outbox.length).toBe(0);

			await startSession(user, CHROME, { remember: false });
			expect(outbox.length).toBe(0);

			await startSession(user, PHONE, { remember: false });
			expect(outbox.length).toBe(1);
			expect(outbox[0]?.to).toBe(user.email);
			expect(outbox[0]?.text).toContain("Safari on iOS");
		});

		test("never alerts an unconfirmed address", async () => {
			const user = makeUser({ emailVerifiedAt: null, status: "PENDING_VERIFICATION" });

			await startSession(user, CHROME, { remember: false });
			await startSession(user, PHONE, { remember: false });

			expect(outbox.length).toBe(0);
		});
	});
});
