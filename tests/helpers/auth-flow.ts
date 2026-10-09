import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app/main";
import { authConfig } from "../../src/packages/configs/auth.config";
import { type MailMessage, setMailer } from "../../src/packages/mailer/mailer";
import { getAuthRepository } from "../../src/packages/repository/drizzle/auth.repository";
import { pick, TestClient, type TestResponse } from "./http";

/** What differs between "in-memory" and "real Postgres": installing the repo and poking at rows. */
export interface FlowBackend {
	install(): Promise<void> | void;
	backdateRotation(sessionId: string): Promise<void>;
	expireSession(sessionId: string): Promise<void>;
	/** Every audit row serialized, for asserting what is NOT stored (raw emails, passwords). */
	auditDump(): Promise<string>;
	/** Event names recorded for an account id, including after the account was deleted. */
	auditEventsForSubject(subjectId: string): Promise<string[]>;
	/** Forget an account's sign-in history, to mimic an account that predates the audit trail. */
	wipeAudit(userId: string): Promise<void>;
}

export const BASE = "/api/v1/auth/email";
export const PASSWORD = "Correct-Horse-9-Battery!";
export const NEW_PASSWORD = "Another-Horse-7-Staple!";
export const CHROME_WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const repo = () => getAuthRepository();
export const newEmail = (prefix = "user"): string =>
	`${prefix}-${crypto.randomUUID().slice(0, 8)}@example.com`;

export const str = (value: unknown): string => {
	if (typeof value !== "string") throw new Error(`expected a string, got ${typeof value}`);
	return value;
};

export const asArray = (value: unknown): unknown[] => {
	if (!Array.isArray(value)) throw new Error("expected an array");
	return value;
};

export const defineAuthFlowTests = (label: string, backend: FlowBackend): void => {
	describe(label, () => {
		const app = createApp();
		const outbox: MailMessage[] = [];

		const browser = (userAgent?: string) =>
			new TestClient(app, userAgent ? { "user-agent": userAgent } : {});

		const signUp = (client: TestClient, email: string, extra: Record<string, unknown> = {}) =>
			client.post(`${BASE}/signup`, {
				json: { fullname: "Test User", email, password: PASSWORD, ...extra },
			});

		const signIn = (
			client: TestClient,
			email: string,
			password = PASSWORD,
			extra: Record<string, unknown> = {},
			headers?: Record<string, string>,
		) => client.post(`${BASE}/signin`, { json: { email, password, ...extra }, headers });

		/** Registers + signs in a fresh account and returns the logged-in browser. */
		const loggedIn = async (userAgent?: string) => {
			const client = browser(userAgent);
			const email = newEmail();
			expect((await signUp(client, email)).status).toBe(201);
			return { client, email };
		};

		const tokenFromMail = (to: string): string => {
			const mail = [...outbox].reverse().find((message) => message.to === to);
			const token = /token=([^\s&]+)/.exec(mail?.text ?? "")?.[1];
			if (!token) throw new Error(`no email with a token was sent to ${to}`);
			return decodeURIComponent(token);
		};

		const mailsTo = (to: string): MailMessage[] =>
			outbox.filter((message) => message.to === to);

		const currentSessionId = async (client: TestClient): Promise<string> => {
			const response = await client.get(`${BASE}/sessions`);
			const current = asArray(pick(response.body, "sessions")).find(
				(session) => pick(session, "current") === true,
			);
			return str(pick(current, "id"));
		};

		const userIdOf = async (email: string): Promise<string> => {
			const user = await repo().findUserByEmail(email);
			if (!user) throw new Error("user not found");
			return user.id;
		};

		beforeAll(async () => {
			await backend.install();
		});

		beforeEach(() => {
			authConfig.requireEmailVerification = false;
			outbox.length = 0;
			setMailer({
				send: async (message) => {
					outbox.push(message);
				},
			});
		});

		// ── Sign up ──────────────────────────────────────────────────────────────

		describe("sign up", () => {
			test("creates the account, sets httpOnly cookies and exposes only public fields", async () => {
				const client = browser();
				const email = newEmail();
				const response = await signUp(client, email);

				expect(response.status).toBe(201);
				expect(pick(response.body, "user.email")).toBe(email);
				expect(pick(response.body, "user.status")).toBe("PENDING_VERIFICATION");

				const access = response.setCookies.find((line) => line.startsWith("access_token="));
				const refresh = response.setCookies.find((line) =>
					line.startsWith("refresh_token="),
				);
				expect(access).toMatch(/httponly/i);
				expect(refresh).toMatch(/httponly/i);
				expect(refresh).toContain(`Path=${BASE}`);

				const serialized = JSON.stringify(response.body);
				expect(serialized).not.toContain("passwordHash");
				expect(serialized).not.toContain("accessToken");

				expect((await client.get(`${BASE}/me`)).status).toBe(200);
			});

			test("trims and lower-cases the email, and sign-in is case-insensitive", async () => {
				const client = browser();
				const email = newEmail("mixed");
				const messy = `  ${email.toUpperCase()} `;

				expect((await signUp(client, messy)).status).toBe(201);

				const second = browser();
				const response = await signIn(second, email);
				expect(response.status).toBe(200);
				expect(pick((await second.get(`${BASE}/me`)).body, "user.email")).toBe(email);
			});

			test("rejects a duplicate email, case-insensitively", async () => {
				const email = newEmail("dupe");
				expect((await signUp(browser(), email)).status).toBe(201);

				expect((await signUp(browser(), email)).status).toBe(409);
				expect((await signUp(browser(), email.toUpperCase())).status).toBe(409);
			});

			test("concurrent sign-ups for one email: exactly one wins and none is a 500", async () => {
				const email = newEmail("race");
				const results = await Promise.all(
					Array.from({ length: 6 }, () => signUp(browser(), email)),
				);

				const statuses = results.map((result) => result.status).sort();
				expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
			});

			test("returns one message per invalid field", async () => {
				const response = await browser().post(`${BASE}/signup`, {
					json: { email: "not-an-email", password: "short" },
				});

				expect(response.status).toBe(422);
				const fields = asArray(pick(response.body, "errors")).map((error) =>
					str(pick(error, "field")),
				);
				expect(fields).toContain("email");
				expect(fields).toContain("password");
				expect(new Set(fields).size).toBe(fields.length);
			});

			test("accepts non-Latin names and long passwords", async () => {
				for (const fullname of ["李小龙", "Ánna Müller", "Nguyễn Văn A"]) {
					expect((await signUp(browser(), newEmail(), { fullname })).status).toBe(201);
				}

				const longPassword = `Aa1!${"x".repeat(96)}`;
				const email = newEmail();
				expect((await signUp(browser(), email, { password: longPassword })).status).toBe(
					201,
				);
				expect((await signIn(browser(), email, longPassword)).status).toBe(200);
			});

			test("stores a missing name as null, not an empty string", async () => {
				const email = newEmail();
				const response = await browser().post(`${BASE}/signup`, {
					json: { email, password: PASSWORD },
				});

				expect(response.status).toBe(201);
				expect(pick(response.body, "user.fullname")).toBeNull();
			});

			test("still succeeds when the mail provider is down", async () => {
				setMailer({
					send: async () => {
						throw new Error("smtp down");
					},
				});

				expect((await signUp(browser(), newEmail())).status).toBe(201);
			});
		});

		// ── Sign in & lockout ────────────────────────────────────────────────────

		describe("sign in", () => {
			test("unknown email and wrong password are indistinguishable", async () => {
				const { email } = await loggedIn();

				const wrongPassword = await signIn(browser(), email, "Wrong-Guess-1!");
				const unknownEmail = await signIn(browser(), newEmail("ghost"), PASSWORD);

				expect(wrongPassword.status).toBe(401);
				expect(unknownEmail.status).toBe(401);
				expect(pick(wrongPassword.body, "message")).toBe(
					pick(unknownEmail.body, "message"),
				);
			});

			test("a non-compliant password is a 401, not a 422", async () => {
				const { email } = await loggedIn();
				expect((await signIn(browser(), email, "x")).status).toBe(401);
			});

			test('treats remember:"false" as false', async () => {
				const { email } = await loggedIn();
				const client = browser();
				await signIn(client, email, PASSWORD, { remember: "false" });

				const [session] = asArray(
					pick((await client.get(`${BASE}/sessions`)).body, "sessions"),
				);
				const lifetimeMs =
					new Date(str(pick(session, "expiresAt"))).getTime() -
					new Date(str(pick(session, "createdAt"))).getTime();

				expect(lifetimeMs).toBeLessThan(2 * 86_400_000);
			});

			test("remember-me controls how long the session and refresh cookie live", async () => {
				const { email } = await loggedIn();
				const maxAge = (response: TestResponse): number =>
					Number(
						/max-age=(\d+)/i.exec(
							response.setCookies.find((line) => line.startsWith("refresh_token=")) ??
								"",
						)?.[1],
					);

				const short = await signIn(browser(), email, PASSWORD, { remember: false });
				const long = await signIn(browser(), email, PASSWORD, { remember: true });

				expect(maxAge(short)).toBeGreaterThan(86_400 - 60);
				expect(maxAge(short)).toBeLessThanOrEqual(86_400);
				expect(maxAge(long)).toBeGreaterThan(authConfig.longSessionTtlSeconds - 60);
			});

			test("locks after repeated failures, and one miss after the lock expires does not re-lock", async () => {
				const { email } = await loggedIn();
				const userId = await userIdOf(email);

				for (let attempt = 0; attempt < authConfig.maxFailedLogins; attempt += 1) {
					expect((await signIn(browser(), email, "Wrong-Guess-1!")).status).toBe(401);
				}

				const locked = await repo().getUserSecurity(userId);
				expect(locked?.lockedUntil).not.toBeNull();

				// Even the right password is refused while locked, with the same generic message.
				const duringLock = await signIn(browser(), email);
				expect(duringLock.status).toBe(401);

				// The lock runs out (counter still at the limit, exactly the old bug's trigger).
				await repo().updateUserSecurity(userId, {
					lockedUntil: new Date(Date.now() - 1_000),
				});

				expect((await signIn(browser(), email, "Wrong-Guess-1!")).status).toBe(401);
				const afterOneMiss = await repo().getUserSecurity(userId);
				expect(afterOneMiss?.failedLoginAttempts).toBe(1);
				expect(afterOneMiss?.lockedUntil).toBeNull();

				expect((await signIn(browser(), email)).status).toBe(200);
				const afterSuccess = await repo().getUserSecurity(userId);
				expect(afterSuccess?.failedLoginAttempts).toBe(0);
			});

			test("parallel wrong guesses are all counted and still lock the account", async () => {
				const { email } = await loggedIn();
				const userId = await userIdOf(email);

				await Promise.all(
					Array.from({ length: 10 }, () => signIn(browser(), email, "Wrong-Guess-1!")),
				);

				const security = await repo().getUserSecurity(userId);
				expect(security?.failedLoginAttempts).toBeGreaterThanOrEqual(
					authConfig.maxFailedLogins,
				);
				expect(security?.lockedUntil).not.toBeNull();
			});

			test("keeps at most maxSessionsPerUser sessions per user", async () => {
				const { email } = await loggedIn();
				const userId = await userIdOf(email);

				for (let index = 0; index < authConfig.maxSessionsPerUser + 3; index += 1) {
					expect((await signIn(browser(), email)).status).toBe(200);
				}

				expect((await repo().listSessionsForUser(userId)).length).toBe(
					authConfig.maxSessionsPerUser,
				);
			});
		});

		// ── Sessions ─────────────────────────────────────────────────────────────

		describe("sessions", () => {
			test("lists devices, marks the current one and hides token internals", async () => {
				const { client, email } = await loggedIn(CHROME_WINDOWS);
				await signIn(browser(IPHONE), email);

				const response = await client.get(`${BASE}/sessions`);
				const sessions = asArray(pick(response.body, "sessions"));

				expect(sessions.length).toBe(2);
				expect(sessions.filter((session) => pick(session, "current") === true).length).toBe(
					1,
				);

				const names = sessions.map((session) => pick(session, "deviceName"));
				expect(names).toContain("Chrome on Windows");
				expect(names).toContain("Safari on iOS");

				const serialized = JSON.stringify(response.body);
				expect(serialized).not.toContain("refreshTokenId");
				expect(serialized).not.toContain("userAgent");
			});

			test("an expired session is rejected for access and refresh alike", async () => {
				const { client } = await loggedIn();
				await backend.expireSession(await currentSessionId(client));

				expect((await client.get(`${BASE}/me`)).status).toBe(401);
				expect((await client.post(`${BASE}/refresh`)).status).toBe(401);
			});

			test("suspending a user cuts off access, refresh and sign-in immediately", async () => {
				const { client, email } = await loggedIn();
				const user = await repo().findUserByEmail(email);
				if (!user) throw new Error("user missing");

				await repo().updateUser({ ...user, status: "SUSPENDED" });

				expect((await client.get(`${BASE}/me`)).status).toBe(403);
				expect((await client.post(`${BASE}/refresh`)).status).toBe(403);
				expect((await signIn(browser(), email)).status).toBe(403);
			});
		});

		// ── Refresh rotation ─────────────────────────────────────────────────────

		describe("refresh", () => {
			test("rotates the refresh token and keeps the session working", async () => {
				const { client } = await loggedIn();
				const before = client.cookie("refresh_token");

				const response = await client.post(`${BASE}/refresh`);
				expect(response.status).toBe(200);
				expect(client.cookie("refresh_token")).not.toBe(before);
				expect((await client.get(`${BASE}/me`)).status).toBe(200);
			});

			test("a token that was just rotated is refused without logging the user out", async () => {
				const { client } = await loggedIn();
				const stale = str(client.cookie("refresh_token"));

				expect((await client.post(`${BASE}/refresh`)).status).toBe(200);

				const otherTab = browser();
				otherTab.setCookie("refresh_token", stale, BASE);
				expect((await otherTab.post(`${BASE}/refresh`)).status).toBe(401);

				// The legitimate holder of the newest token is unaffected.
				expect((await client.post(`${BASE}/refresh`)).status).toBe(200);
				expect((await client.get(`${BASE}/me`)).status).toBe(200);
			});

			test("replaying an old token after the grace window revokes the whole session", async () => {
				const { client } = await loggedIn();
				const sessionId = await currentSessionId(client);
				const stolen = str(client.cookie("refresh_token"));

				expect((await client.post(`${BASE}/refresh`)).status).toBe(200);
				await backend.backdateRotation(sessionId);

				const attacker = browser();
				attacker.setCookie("refresh_token", stolen, BASE);
				expect((await attacker.post(`${BASE}/refresh`)).status).toBe(401);

				// Everyone on that session, including the victim, is now signed out.
				expect((await client.get(`${BASE}/me`)).status).toBe(401);
				expect((await client.post(`${BASE}/refresh`)).status).toBe(401);
			});

			test("two parallel refreshes with one token: one wins, the session survives", async () => {
				const { client } = await loggedIn();
				const shared = str(client.cookie("refresh_token"));

				const tabs = [browser(), browser()];
				for (const tab of tabs) tab.setCookie("refresh_token", shared, BASE);

				const statuses = (await Promise.all(tabs.map((tab) => tab.post(`${BASE}/refresh`))))
					.map((response) => response.status)
					.sort();
				expect(statuses).toEqual([200, 401]);

				const winner = tabs.find((tab) => tab.cookie("refresh_token") !== shared);
				expect((await winner?.post(`${BASE}/refresh`))?.status).toBe(200);
			});

			test("without any token it is a 401", async () => {
				expect((await browser().post(`${BASE}/refresh`)).status).toBe(401);
			});

			test("an access token is not accepted as a refresh token, nor the reverse", async () => {
				const client = browser();
				const email = newEmail();
				const signedUp = await signUp(client, email, {}).then(() =>
					signIn(browser(), email, PASSWORD, {}, { "x-auth-mode": "token" }),
				);
				const access = str(pick(signedUp.body, "tokens.accessToken"));
				const refresh = str(pick(signedUp.body, "tokens.refreshToken"));

				const asRefresh = await browser().post(`${BASE}/refresh`, {
					json: { refreshToken: access },
				});
				expect(asRefresh.status).toBe(401);

				const asAccess = await browser().get(`${BASE}/me`, { bearer: refresh });
				expect(asAccess.status).toBe(401);
			});
		});

		// ── Token-in-body / Bearer mode ──────────────────────────────────────────

		describe("non-browser clients", () => {
			test("get tokens only when they opt in, and can refresh from the body", async () => {
				const { email } = await loggedIn();

				const plain = await signIn(browser(), email);
				expect(pick(plain.body, "tokens")).toBeUndefined();

				const opted = await signIn(
					browser(),
					email,
					PASSWORD,
					{},
					{ "x-auth-mode": "token" },
				);
				const refreshToken = str(pick(opted.body, "tokens.refreshToken"));

				const refreshed = await browser().post(`${BASE}/refresh`, {
					json: { refreshToken },
					headers: { "x-auth-mode": "token" },
				});
				expect(refreshed.status).toBe(200);
				expect(str(pick(refreshed.body, "tokens.accessToken")).length).toBeGreaterThan(20);
			});

			test("Bearer works without cookies or a CSRF token", async () => {
				const { email } = await loggedIn();
				const opted = await signIn(
					browser(),
					email,
					PASSWORD,
					{},
					{ "x-auth-mode": "token" },
				);
				const bearer = str(pick(opted.body, "tokens.accessToken"));

				const api = browser();
				expect((await api.get(`${BASE}/me`, { bearer })).status).toBe(200);
				expect((await api.post(`${BASE}/signout`, { bearer })).status).toBe(200);
				expect((await api.get(`${BASE}/me`, { bearer })).status).toBe(401);
			});
		});

		// ── Sign out ─────────────────────────────────────────────────────────────

		describe("sign out", () => {
			test("kills the access and refresh token at once and clears the cookies", async () => {
				const email = newEmail();
				await signUp(browser(), email);
				const opted = await signIn(
					browser(),
					email,
					PASSWORD,
					{},
					{ "x-auth-mode": "token" },
				);
				const access = str(pick(opted.body, "tokens.accessToken"));
				const refresh = str(pick(opted.body, "tokens.refreshToken"));

				const client = browser();
				await signIn(client, email);
				expect((await client.post(`${BASE}/signout`)).status).toBe(200);
				expect(client.hasCookie("access_token")).toBe(false);
				expect(client.hasCookie("refresh_token")).toBe(false);

				// A different login of the same user is unaffected...
				expect((await browser().get(`${BASE}/me`, { bearer: access })).status).toBe(200);

				// ...but signing out the token-mode login ends exactly that session.
				await browser().post(`${BASE}/signout`, { bearer: access });
				expect((await browser().get(`${BASE}/me`, { bearer: access })).status).toBe(401);
				expect(
					(await browser().post(`${BASE}/refresh`, { json: { refreshToken: refresh } }))
						.status,
				).toBe(401);
			});

			test("never fails, even with no credentials at all", async () => {
				expect((await browser().post(`${BASE}/signout`)).status).toBe(200);
			});

			test("works from the refresh cookie alone when the access token has expired", async () => {
				const { client } = await loggedIn();
				const sessionId = await currentSessionId(client);

				client.dropCookie("access_token");
				expect((await client.post(`${BASE}/signout`)).status).toBe(200);
				expect(await repo().getSession(sessionId)).toBeUndefined();
			});
		});

		// ── CSRF & routing ───────────────────────────────────────────────────────

		describe("transport", () => {
			test("state-changing requests need the CSRF header", async () => {
				const client = browser();
				const email = newEmail();

				const rejected = await client.post(`${BASE}/signup`, {
					json: { email, password: PASSWORD },
					noCsrf: true,
				});
				expect(rejected.status).toBe(403);

				expect((await signUp(client, email)).status).toBe(201);
			});

			test("serves the CSRF token for cross-origin frontends", async () => {
				const response = await browser().get("/api/v1/csrf");
				expect(response.status).toBe(200);
				expect(str(pick(response.body, "csrfToken")).length).toBeGreaterThan(16);
			});

			test("auth lives under the versioned API base only", async () => {
				expect((await browser().get("/auth/email/me")).status).toBe(404);
				expect((await browser().get(`${BASE}/me`)).status).toBe(401);
			});
		});

		// ── Email verification ───────────────────────────────────────────────────

		describe("email verification", () => {
			test("sign-up mails a single-use link that activates the account", async () => {
				const { client, email } = await loggedIn();
				const token = tokenFromMail(email);

				expect(
					(await client.post(`${BASE}/verify-email`, { json: { token } })).status,
				).toBe(200);
				expect(pick((await client.get(`${BASE}/me`)).body, "user.status")).toBe("ACTIVE");

				const reuse = await client.post(`${BASE}/verify-email`, { json: { token } });
				expect(reuse.status).toBe(400);
			});

			test("rejects unknown tokens", async () => {
				const response = await browser().post(`${BASE}/verify-email`, {
					json: { token: "a".repeat(40) },
				});
				expect(response.status).toBe(400);
			});

			test("the same link used twice in parallel succeeds exactly once", async () => {
				const { email } = await loggedIn();
				const token = tokenFromMail(email);

				const statuses = (
					await Promise.all(
						Array.from({ length: 4 }, () =>
							browser().post(`${BASE}/verify-email`, { json: { token } }),
						),
					)
				)
					.map((response) => response.status)
					.sort();

				expect(statuses).toEqual([200, 400, 400, 400]);
			});

			test("resend gives the same answer for everyone and only mails pending accounts", async () => {
				const { email } = await loggedIn();
				const first = tokenFromMail(email);
				const ghost = newEmail("ghost");

				const known = await browser().post(`${BASE}/resend-verification`, {
					json: { email },
				});
				const unknown = await browser().post(`${BASE}/resend-verification`, {
					json: { email: ghost },
				});

				expect(known.status).toBe(202);
				expect(unknown.status).toBe(202);
				expect(pick(known.body, "message")).toBe(pick(unknown.body, "message"));
				expect(mailsTo(ghost).length).toBe(0);

				// Only the newest link works.
				const second = tokenFromMail(email);
				expect(second).not.toBe(first);
				expect(
					(await browser().post(`${BASE}/verify-email`, { json: { token: first } }))
						.status,
				).toBe(400);
				expect(
					(await browser().post(`${BASE}/verify-email`, { json: { token: second } }))
						.status,
				).toBe(200);

				// Already verified: no further mail.
				const before = mailsTo(email).length;
				await browser().post(`${BASE}/resend-verification`, { json: { email } });
				expect(mailsTo(email).length).toBe(before);
			});

			test("when verification is required, sign-up issues no session and sign-in waits", async () => {
				authConfig.requireEmailVerification = true;
				const client = browser();
				const email = newEmail();

				const created = await signUp(client, email);
				expect(created.status).toBe(201);
				expect(pick(created.body, "requiresVerification")).toBe(true);
				expect(created.setCookies.length).toBe(0);

				expect((await signIn(browser(), email, "Wrong-Guess-1!")).status).toBe(401);
				expect((await signIn(browser(), email)).status).toBe(403);

				await browser().post(`${BASE}/verify-email`, {
					json: { token: tokenFromMail(email) },
				});
				expect((await signIn(browser(), email)).status).toBe(200);
			});
		});

		// ── Password reset ───────────────────────────────────────────────────────

		describe("password reset", () => {
			const forgot = (email: string) =>
				browser().post(`${BASE}/forgot-password`, { json: { email } });

			const reset = (token: string, password = NEW_PASSWORD, confirmPassword = password) =>
				browser().post(`${BASE}/reset-password`, {
					json: { token, password, confirmPassword },
				});

			test("answers identically for known and unknown emails, and mails only the real one", async () => {
				const { email } = await loggedIn();
				const ghost = newEmail("ghost");
				const before = mailsTo(email).length;

				const known = await forgot(email);
				const unknown = await forgot(ghost);

				expect(known.status).toBe(202);
				expect(unknown.status).toBe(202);
				expect(pick(known.body, "message")).toBe(pick(unknown.body, "message"));
				expect(mailsTo(email).length).toBe(before + 1);
				expect(mailsTo(ghost).length).toBe(0);
			});

			test("changes the password, signs out every device, clears the lock and is single-use", async () => {
				const { client, email } = await loggedIn();
				const userId = await userIdOf(email);

				for (let attempt = 0; attempt < authConfig.maxFailedLogins; attempt += 1) {
					await signIn(browser(), email, "Wrong-Guess-1!");
				}
				expect((await repo().getUserSecurity(userId))?.lockedUntil).not.toBeNull();

				await forgot(email);
				const token = tokenFromMail(email);

				expect((await reset(token)).status).toBe(200);
				expect((await reset(token)).status).toBe(400);

				expect((await client.get(`${BASE}/me`)).status).toBe(401);
				expect((await signIn(browser(), email, PASSWORD)).status).toBe(401);
				expect((await signIn(browser(), email, NEW_PASSWORD)).status).toBe(200);
			});

			test("enforces the password policy and confirmation", async () => {
				const { email } = await loggedIn();
				await forgot(email);
				const token = tokenFromMail(email);

				expect((await reset(token, "short")).status).toBe(422);
				expect((await reset(token, NEW_PASSWORD, "Different-Guess-2!")).status).toBe(422);

				// Failed validation must not burn the link.
				expect((await reset(token)).status).toBe(200);
			});

			test("sends nothing for a suspended account", async () => {
				const { email } = await loggedIn();
				const user = await repo().findUserByEmail(email);
				if (!user) throw new Error("user missing");
				await repo().updateUser({ ...user, status: "SUSPENDED" });
				const before = mailsTo(email).length;

				expect((await forgot(email)).status).toBe(202);
				expect(mailsTo(email).length).toBe(before);
			});
		});
	});
};
