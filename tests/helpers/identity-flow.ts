import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { DeviceInfo } from "../../src/app/auth/core/auth.types";
import {
	type ExternalIdentity,
	IdentityRefusal,
	resolveExternalIdentity,
} from "../../src/app/auth/core/identity.service";
import { startSession } from "../../src/app/auth/core/session.service";
import { createApp } from "../../src/app/main";
import { authConfig } from "../../src/packages/configs/auth.config";
import { type MailMessage, setMailer } from "../../src/packages/mailer/mailer";
import { getAuthRepository } from "../../src/packages/repository/drizzle/auth.repository";
import type { User } from "../../src/packages/schema/user.schema";
import { isUniqueViolation } from "../../src/packages/utils/db-errors";
import { BASE, NEW_PASSWORD, newEmail, PASSWORD, str } from "./auth-flow";
import { pick, TestClient } from "./http";

/** What differs between "in-memory" and "real Postgres" for these tests. */
export interface IdentityBackend {
	install(): Promise<void> | void;
	/** Pretend the session was created at `to` (re-authentication looks at session age). */
	backdateSignIn(sessionId: string, to: Date): Promise<void>;
}

const ACCOUNT = "/api/v1/account";
const WRONG = "Wrong-Guess-1!";

const DEVICE: DeviceInfo = {
	deviceName: "Chrome on Windows",
	platform: "desktop",
	browser: "Chrome",
	os: "Windows",
	ipAddress: "203.0.113.9",
	userAgent: "test-chrome",
};

const repo = () => getAuthRepository();

const googleIdentity = (overrides: Partial<ExternalIdentity> = {}): ExternalIdentity => ({
	provider: "GOOGLE",
	providerUserId: `g-${crypto.randomUUID()}`,
	email: newEmail("google"),
	emailVerified: true,
	fullname: "Ann Lee",
	avatarUrl: "https://example.com/avatar.png",
	...overrides,
});

const resolve = (identity: ExternalIdentity) => resolveExternalIdentity(identity, DEVICE);

/** Runs resolve() and reports the refusal reason, or what else happened. */
const refusalOf = async (identity: ExternalIdentity): Promise<string> => {
	try {
		await resolve(identity);
		return "not refused";
	} catch (error) {
		return error instanceof IdentityRefusal ? error.reason : `unexpected: ${String(error)}`;
	}
};

export const defineIdentityTests = (label: string, backend: IdentityBackend): void => {
	describe(label, () => {
		const app = createApp();
		const outbox: MailMessage[] = [];

		const browser = () => new TestClient(app);
		const mailsTo = (to: string) => outbox.filter((mail) => mail.to === to);

		const tokenFromMail = (to: string): string => {
			const mail = [...outbox].reverse().find((m) => m.to === to && /token=/.test(m.text));
			const token = /token=([^\s&]+)/.exec(mail?.text ?? "")?.[1];
			if (!token) throw new Error(`no email with a token was sent to ${to}`);
			return decodeURIComponent(token);
		};

		const auditEvents = async (userId: string) =>
			(await repo().listAuditLogsForUser(userId, { limit: 100 })).map((row) => row.event);

		/** An email + password account. `confirmed` mimics having clicked the verification link. */
		const emailAccount = async (confirmed: boolean) => {
			const client = browser();
			const email = newEmail("local");
			expect(
				(
					await client.post(`${BASE}/signup`, {
						json: { fullname: "Local User", email, password: PASSWORD },
					})
				).status,
			).toBe(201);

			if (confirmed) {
				const verify = await client.post(`${BASE}/verify-email`, {
					json: { token: tokenFromMail(email) },
				});
				expect(verify.status).toBe(200);
			}

			const user = await repo().findUserByEmail(email);
			if (!user) throw new Error("account missing");
			return { client, email, user };
		};

		/** A provider-only account (no password) with a live session, authenticated by Bearer. */
		const providerAccount = async () => {
			const identity = googleIdentity();
			const { user } = await resolve(identity);
			const login = await startSession(user, DEVICE, { remember: false });
			return {
				identity,
				user,
				sessionId: login.session.id,
				bearer: login.tokens.accessToken,
				refreshToken: login.tokens.refreshToken,
			};
		};

		const asBearer = (bearer: string) => ({ bearer });

		const staleSession = (sessionId: string) =>
			backend.backdateSignIn(
				sessionId,
				new Date(Date.now() - (authConfig.reauthWindowSeconds + 5) * 1_000),
			);

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

		// ── Resolving a provider identity ────────────────────────────────────────

		describe("resolving a provider identity", () => {
			test("creates an account for an unknown, verified email", async () => {
				const identity = googleIdentity({ email: `  ${newEmail("Fresh").toUpperCase()} ` });
				const { user, outcome, oauthAccountId } = await resolve(identity);

				expect(outcome).toBe("created");
				expect(user.email).toBe(identity.email?.trim().toLowerCase() ?? "");
				expect(user.status).toBe("ACTIVE");
				expect(user.emailVerifiedAt).not.toBeNull();
				expect(user.role).toBe("USER");

				expect((await repo().getUserSecurity(user.id))?.passwordHash).toBeNull();
				expect(await repo().getUserProfile(user.id)).toBeDefined();
				expect(await repo().getUserPreferences(user.id)).toBeDefined();

				const links = await repo().listOAuthAccountsForUser(user.id);
				expect(links.map((l) => [l.provider, l.providerUserId, l.id])).toEqual([
					["GOOGLE", identity.providerUserId, oauthAccountId],
				]);

				const events = await auditEvents(user.id);
				expect(events).toContain("SIGN_UP");
				const signUp = (await repo().listAuditLogsForUser(user.id, { limit: 10 })).find(
					(row) => row.event === "SIGN_UP",
				);
				expect(signUp?.metadata.provider).toBe("GOOGLE");
			});

			test("keeps good provider profile data and drops anything the form would reject", async () => {
				const kept = await resolve(googleIdentity({ fullname: "Ánna Müller" }));
				expect(kept.user.fullname).toBe("Ánna Müller");
				expect(kept.user.avatarUrl).toBe("https://example.com/avatar.png");

				const cleaned = await resolve(
					googleIdentity({
						fullname: "R2D2 <script>alert(1)</script>",
						avatarUrl: "javascript:alert(1)",
					}),
				);
				expect(cleaned.user.fullname).toBeNull();
				expect(cleaned.user.avatarUrl).toBeNull();

				for (const avatarUrl of [
					"http://insecure.example.com/a.png",
					"data:image/png;base64,AAAA",
					"",
				]) {
					const result = await resolve(googleIdentity({ avatarUrl }));
					expect(`${avatarUrl} -> ${result.user.avatarUrl}`).toBe(`${avatarUrl} -> null`);
				}
			});

			test("links to an existing VERIFIED email account and leaves its password alone", async () => {
				const { email, user } = await emailAccount(true);

				const result = await resolve(
					googleIdentity({ email: `  ${email.toUpperCase()}  ` }),
				);

				expect(result.outcome).toBe("linked");
				expect(result.user.id).toBe(user.id);
				expect((await repo().listOAuthAccountsForUser(user.id)).length).toBe(1);

				// Same account, both ways in.
				expect(
					(
						await browser().post(`${BASE}/signin`, {
							json: { email, password: PASSWORD },
						})
					).status,
				).toBe(200);

				const events = await auditEvents(user.id);
				expect(events).toContain("OAUTH_ACCOUNT_LINKED");
				expect(events).not.toContain("ACCOUNT_RECLAIMED");
			});

			test("RECLAIMS an unverified email account: nothing the registrant held survives", async () => {
				const { client, email, user } = await emailAccount(false);
				const verifyToken = tokenFromMail(email);
				await browser().post(`${BASE}/forgot-password`, { json: { email } });
				const resetToken = tokenFromMail(email);
				expect((await client.get(`${BASE}/me`)).status).toBe(200);

				const result = await resolve(googleIdentity({ email }));

				expect(result.outcome).toBe("reclaimed");
				expect(result.user.id).toBe(user.id);
				expect(result.user.status).toBe("ACTIVE");
				expect(result.user.emailVerifiedAt).not.toBeNull();
				expect((await repo().getUserSecurity(user.id))?.passwordHash).toBeNull();

				// The password the registrant chose, their session, and both emailed links are all dead.
				expect(
					(
						await browser().post(`${BASE}/signin`, {
							json: { email, password: PASSWORD },
						})
					).status,
				).toBe(401);
				expect((await client.get(`${BASE}/me`)).status).toBe(401);
				expect(
					(await browser().post(`${BASE}/verify-email`, { json: { token: verifyToken } }))
						.status,
				).toBe(400);
				expect(
					(
						await browser().post(`${BASE}/reset-password`, {
							json: {
								token: resetToken,
								password: NEW_PASSWORD,
								confirmPassword: NEW_PASSWORD,
							},
						})
					).status,
				).toBe(400);

				const events = await auditEvents(user.id);
				expect(events).toContain("ACCOUNT_RECLAIMED");
				expect(events).toContain("OAUTH_ACCOUNT_LINKED");
			});

			test("a linked identity is matched by its provider id, not by email", async () => {
				const identity = googleIdentity();
				const first = await resolve(identity);
				const originalEmail = first.user.email;

				// The provider now reports a different address for the same person.
				const moved = newEmail("moved");
				const again = await resolve({ ...identity, email: moved });

				expect(again.outcome).toBe("existing");
				expect(again.user.id).toBe(first.user.id);
				expect(again.user.email).toBe(originalEmail);
				expect(await repo().findUserByEmail(moved)).toBeUndefined();

				// Once linked, no email is needed at all.
				const bare = await resolve({ ...identity, email: null, emailVerified: false });
				expect(bare.outcome).toBe("existing");
				expect(bare.user.id).toBe(first.user.id);
			});

			test("records when the identity was last used", async () => {
				const identity = googleIdentity();
				await resolve(identity);
				const before = (await repo().findOAuthAccount("GOOGLE", identity.providerUserId))
					?.lastLoginAt;

				await Bun.sleep(20);
				await resolve(identity);
				const after = (await repo().findOAuthAccount("GOOGLE", identity.providerUserId))
					?.lastLoginAt;

				expect(after && before && after.getTime() > before.getTime()).toBe(true);
			});

			test("refuses an email the provider has not verified, even for an existing account", async () => {
				expect(await refusalOf(googleIdentity({ emailVerified: false }))).toBe(
					"email_unverified",
				);

				// The dangerous case: someone's own Google account claims a VICTIM's address, unverified.
				const { email, user } = await emailAccount(true);
				expect(await refusalOf(googleIdentity({ email, emailVerified: false }))).toBe(
					"email_unverified",
				);
				expect(await repo().listOAuthAccountsForUser(user.id)).toEqual([]);
			});

			test("refuses a missing or blank email", async () => {
				for (const email of [null, undefined, "", "   "]) {
					expect(
						`${String(email)} -> ${await refusalOf(googleIdentity({ email }))}`,
					).toBe(`${String(email)} -> email_missing`);
				}
			});

			test("refuses blocked accounts, both via a link and via the email", async () => {
				// via an existing link
				const identity = googleIdentity();
				const { user } = await resolve(identity);
				await repo().updateUser({ ...user, status: "SUSPENDED" });
				expect(await refusalOf(identity)).toBe("account_blocked");

				// via the email of a suspended email account: no link may be created
				const local = await emailAccount(true);
				await repo().updateUser({ ...local.user, status: "SUSPENDED" });
				expect(await refusalOf(googleIdentity({ email: local.email }))).toBe(
					"account_blocked",
				);
				expect(await repo().listOAuthAccountsForUser(local.user.id)).toEqual([]);
			});

			test("never merges a second account from the same provider into one email", async () => {
				const first = googleIdentity();
				const { user } = await resolve(first);

				const intruder = googleIdentity({ email: user.email });
				expect(await refusalOf(intruder)).toBe("provider_conflict");

				const links = await repo().listOAuthAccountsForUser(user.id);
				expect(links.map((l) => l.providerUserId)).toEqual([first.providerUserId]);
			});

			test("one account can hold several different providers", async () => {
				const google = googleIdentity();
				const { user } = await resolve(google);

				const discord = await resolve({
					provider: "DISCORD",
					providerUserId: `d-${crypto.randomUUID()}`,
					email: user.email,
					emailVerified: true,
				});

				expect(discord.outcome).toBe("linked");
				expect(discord.user.id).toBe(user.id);
				const providers = (await repo().listOAuthAccountsForUser(user.id))
					.map((l) => l.provider)
					.sort();
				expect(providers).toEqual(["DISCORD", "GOOGLE"]);
			});

			test("the database itself forbids sharing an identity or doubling a provider", async () => {
				const identity = googleIdentity();
				const { user, oauthAccountId } = await resolve(identity);
				const other = await emailAccount(true);
				const now = new Date();

				const attempt = (
					userId: string,
					provider: "GOOGLE" | "DISCORD",
					providerUserId: string,
				) =>
					repo()
						.createOAuthAccount({
							id: crypto.randomUUID(),
							userId,
							provider,
							providerUserId,
							createdAt: now,
							lastLoginAt: now,
						})
						.then(
							() => "allowed",
							(error: unknown) =>
								isUniqueViolation(error)
									? "unique violation"
									: `other: ${String(error)}`,
						);

				// same provider identity on a different account
				expect(await attempt(other.user.id, "GOOGLE", identity.providerUserId)).toBe(
					"unique violation",
				);
				// a second Google identity on the same account
				expect(await attempt(user.id, "GOOGLE", `g-${crypto.randomUUID()}`)).toBe(
					"unique violation",
				);
				// a different provider is fine
				expect(await attempt(user.id, "DISCORD", `d-${crypto.randomUUID()}`)).toBe(
					"allowed",
				);
				expect(oauthAccountId).toBeTruthy();
			});

			test("matches the email case-insensitively and ignoring padding", async () => {
				const client = browser();
				const email = newEmail("MixedCase");
				await client.post(`${BASE}/signup`, {
					json: { fullname: "Mixed Case", email, password: PASSWORD },
				});
				await client.post(`${BASE}/verify-email`, {
					json: { token: tokenFromMail(email.toLowerCase()) },
				});

				const result = await resolve(
					googleIdentity({ email: `   ${email.toUpperCase()}   ` }),
				);
				expect(result.outcome).toBe("linked");
			});

			test("deleting the account frees the identity to start fresh", async () => {
				const identity = googleIdentity();
				const first = await resolve(identity);
				await repo().deleteUser(first.user.id);

				expect(
					await repo().findOAuthAccount("GOOGLE", identity.providerUserId),
				).toBeUndefined();

				const second = await resolve(identity);
				expect(second.outcome).toBe("created");
				expect(second.user.id).not.toBe(first.user.id);
			});

			test("refusals carry a stable reason and a 403", async () => {
				const failure = await resolve(googleIdentity({ emailVerified: false })).then(
					() => undefined,
					(error: unknown) => error,
				);

				expect(failure).toBeInstanceOf(IdentityRefusal);
				expect(failure instanceof IdentityRefusal && failure.statusCode).toBe(403);
				expect(failure instanceof IdentityRefusal && failure.reason).toBe(
					"email_unverified",
				);
			});
		});

		// ── Races ────────────────────────────────────────────────────────────────

		describe("racing sign-ins", () => {
			test("six simultaneous first sign-ins create exactly one account", async () => {
				const identity = googleIdentity();

				const results = await Promise.all(
					Array.from({ length: 6 }, () => resolve(identity)),
				);

				const ids = new Set(results.map((result) => result.user.id));
				expect(ids.size).toBe(1);
				expect(results.filter((result) => result.outcome === "created").length).toBe(1);
				expect(results.filter((result) => result.outcome === "existing").length).toBe(5);

				const [userId] = ids;
				expect((await repo().listOAuthAccountsForUser(userId ?? "")).length).toBe(1);
				expect(
					(await auditEvents(userId ?? "")).filter((event) => event === "SIGN_UP").length,
				).toBe(1);
			});

			test("six simultaneous sign-ins that link an existing account create one link", async () => {
				const { email, user } = await emailAccount(true);
				const identity = googleIdentity({ email });

				const results = await Promise.all(
					Array.from({ length: 6 }, () => resolve(identity)),
				);

				expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
				expect(results.filter((result) => result.outcome === "linked").length).toBe(1);
				expect((await repo().listOAuthAccountsForUser(user.id)).length).toBe(1);
				expect(
					(await auditEvents(user.id)).filter((event) => event === "OAUTH_ACCOUNT_LINKED")
						.length,
				).toBe(1);
			});

			test("simultaneous reclaims of one unverified account still end with one link", async () => {
				const { email, user } = await emailAccount(false);
				const identity = googleIdentity({ email });

				const results = await Promise.all(
					Array.from({ length: 4 }, () => resolve(identity)),
				);

				expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
				expect((await repo().listOAuthAccountsForUser(user.id)).length).toBe(1);
				expect((await repo().getUserSecurity(user.id))?.passwordHash).toBeNull();
			});
		});

		// ── Accounts without a password ──────────────────────────────────────────

		describe("accounts without a password", () => {
			const changePassword = (bearer: string, body: Record<string, unknown>) =>
				browser().post(`${BASE}/change-password`, { json: body, ...asBearer(bearer) });

			test("email sign-in gets the same generic answer, and nothing counts toward a lockout", async () => {
				const { user } = await providerAccount();
				const normal = await emailAccount(true);

				const providerOnly = await browser().post(`${BASE}/signin`, {
					json: { email: user.email, password: PASSWORD },
				});
				const wrongPassword = await browser().post(`${BASE}/signin`, {
					json: { email: normal.email, password: WRONG },
				});

				expect(providerOnly.status).toBe(401);
				expect(pick(providerOnly.body, "message")).toBe(
					pick(wrongPassword.body, "message"),
				);

				for (let attempt = 0; attempt < authConfig.maxFailedLogins + 3; attempt += 1) {
					await browser().post(`${BASE}/signin`, {
						json: { email: user.email, password: WRONG },
					});
				}

				const security = await repo().getUserSecurity(user.id);
				expect(security?.failedLoginAttempts).toBe(0);
				expect(security?.lockedUntil).toBeNull();

				const rows = await repo().listAuditLogsForUser(user.id, { limit: 50 });
				expect(rows.some((row) => row.metadata.reason === "no_password")).toBe(true);
			});

			test("/me says whether the account has a password", async () => {
				const provider = await providerAccount();
				const providerMe = await browser().get(`${BASE}/me`, asBearer(provider.bearer));
				expect(pick(providerMe.body, "user.hasPassword")).toBe(false);

				const normal = await emailAccount(true);
				const normalMe = await normal.client.get(`${BASE}/me`);
				expect(pick(normalMe.body, "user.hasPassword")).toBe(true);
			});

			test("a recent sign-in lets them SET a first password, which then works for email sign-in", async () => {
				const { user, bearer, sessionId } = await providerAccount();
				const other = await startSession(
					user,
					{ ...DEVICE, deviceName: "Safari on iOS" },
					{ remember: false },
				);

				const response = await changePassword(bearer, {
					newPassword: NEW_PASSWORD,
					confirmPassword: NEW_PASSWORD,
				});

				expect(response.status).toBe(200);
				expect(String(pick(response.body, "message"))).toContain("Password set");

				expect(
					(
						await browser().post(`${BASE}/signin`, {
							json: { email: user.email, password: NEW_PASSWORD },
						})
					).status,
				).toBe(200);
				const me = await browser().get(`${BASE}/me`, asBearer(bearer));
				expect(pick(me.body, "user.hasPassword")).toBe(true);

				// Other sessions end; this one survives.
				expect(
					(await browser().get(`${BASE}/me`, asBearer(other.tokens.accessToken))).status,
				).toBe(401);
				expect(await repo().getSession(sessionId)).toBeDefined();

				const notice = mailsTo(user.email).find((mail) =>
					/password was added/i.test(mail.subject),
				);
				expect(notice).toBeDefined();

				const changed = (await repo().listAuditLogsForUser(user.id, { limit: 50 })).find(
					(row) => row.event === "PASSWORD_CHANGED",
				);
				expect(changed?.metadata.firstPassword).toBe(true);

				// From now on it behaves like any account with a password.
				const again = await changePassword(bearer, {
					newPassword: "Third-Horse-5-Clip!",
					confirmPassword: "Third-Horse-5-Clip!",
				});
				expect(again.status).toBe(403);
				expect(String(pick(again.body, "message"))).toContain(
					"Current password is required",
				);
			});

			test("a stale sign-in is refused, and refreshing does not make it fresh again", async () => {
				const { user, bearer, sessionId, refreshToken } = await providerAccount();
				await staleSession(sessionId);

				const refused = await changePassword(bearer, {
					newPassword: NEW_PASSWORD,
					confirmPassword: NEW_PASSWORD,
				});
				expect(refused.status).toBe(403);
				expect(String(pick(refused.body, "message"))).toContain("Recent sign-in required");
				expect((await repo().getUserSecurity(user.id))?.passwordHash).toBeNull();

				const rows = await repo().listAuditLogsForUser(user.id, { limit: 50 });
				const failure = rows.find((row) => row.event === "REAUTH_FAILURE");
				expect(failure?.metadata.reason).toBe("stale_session");

				// A refresh keeps the same session row, so it must not count as signing in again.
				const refreshed = await browser().post(`${BASE}/refresh`, {
					json: { refreshToken },
					headers: { "x-auth-mode": "token" },
				});
				expect(refreshed.status).toBe(200);
				const freshAccess = str(pick(refreshed.body, "tokens.accessToken"));

				const stillRefused = await changePassword(freshAccess, {
					newPassword: NEW_PASSWORD,
					confirmPassword: NEW_PASSWORD,
				});
				expect(stillRefused.status).toBe(403);
				expect(String(pick(stillRefused.body, "message"))).toContain(
					"Recent sign-in required",
				);
			});

			test("changing the email needs only a recent sign-in, and a typed password is ignored", async () => {
				const { bearer, user, sessionId } = await providerAccount();
				const moved = newEmail("moved");

				const ok = await browser().post(`${BASE}/change-email`, {
					json: { newEmail: moved, password: "anything-at-all" },
					...asBearer(bearer),
				});
				expect(ok.status).toBe(202);
				expect(mailsTo(moved).length).toBe(1);
				expect(
					mailsTo(user.email).some((mail) => /change of email/i.test(mail.subject)),
				).toBe(true);

				await staleSession(sessionId);
				const stale = await browser().post(`${BASE}/change-email`, {
					json: { newEmail: newEmail("again") },
					...asBearer(bearer),
				});
				expect(stale.status).toBe(403);
			});

			test("deleting the account needs only a recent sign-in", async () => {
				const fresh = await providerAccount();
				const ok = await browser().post(`${ACCOUNT}/delete`, {
					json: {},
					...asBearer(fresh.bearer),
				});
				expect(ok.status).toBe(200);
				expect(await repo().findUserById(fresh.user.id)).toBeUndefined();

				const stale = await providerAccount();
				await staleSession(stale.sessionId);
				const refused = await browser().post(`${ACCOUNT}/delete`, {
					json: {},
					...asBearer(stale.bearer),
				});
				expect(refused.status).toBe(403);
				expect(await repo().findUserById(stale.user.id)).toBeDefined();
			});

			test("an account WITH a password still has to give it, and leaving it out is not a guess", async () => {
				const { client, user } = await emailAccount(true);

				const missing = await client.post(`${ACCOUNT}/delete`, { json: {} });
				expect(missing.status).toBe(403);
				expect(String(pick(missing.body, "message"))).toContain(
					"Current password is required",
				);

				const wrong = await client.post(`${ACCOUNT}/delete`, { json: { password: WRONG } });
				expect(wrong.status).toBe(403);

				// Only the wrong attempt counted.
				expect((await repo().getUserSecurity(user.id))?.failedLoginAttempts).toBe(1);
				expect(await repo().findUserById(user.id)).toBeDefined();
			});

			test("an empty current password is a validation error, not 'no password'", async () => {
				const { bearer } = await providerAccount();
				const response = await changePassword(bearer, {
					currentPassword: "",
					newPassword: NEW_PASSWORD,
					confirmPassword: NEW_PASSWORD,
				});
				expect(response.status).toBe(422);
			});

			test("forgot-password is the way in to a password: email, link, new password, sign in", async () => {
				const { user, bearer } = await providerAccount();

				const forgot = await browser().post(`${BASE}/forgot-password`, {
					json: { email: user.email },
				});
				expect(forgot.status).toBe(202);

				const reset = await browser().post(`${BASE}/reset-password`, {
					json: {
						token: tokenFromMail(user.email),
						password: NEW_PASSWORD,
						confirmPassword: NEW_PASSWORD,
					},
				});
				expect(reset.status).toBe(200);

				const signedIn = browser();
				expect(
					(
						await signedIn.post(`${BASE}/signin`, {
							json: { email: user.email, password: NEW_PASSWORD },
						})
					).status,
				).toBe(200);
				expect(pick((await signedIn.get(`${BASE}/me`)).body, "user.hasPassword")).toBe(
					true,
				);
				// Existing behavior: a reset signs everything else out.
				expect((await browser().get(`${BASE}/me`, asBearer(bearer))).status).toBe(401);
			});

			test("signing up by email for a provider account's address is still a 409", async () => {
				const { user } = await providerAccount();
				const response = await browser().post(`${BASE}/signup`, {
					json: { fullname: "Someone Else", email: user.email, password: PASSWORD },
				});
				expect(response.status).toBe(409);
			});
		});
	});
};

export type { User };
