import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app/main";
import { authConfig } from "../../src/packages/configs/auth.config";
import { type MailMessage, setMailer } from "../../src/packages/mailer/mailer";
import { getAuthRepository } from "../../src/packages/repository/drizzle/auth.repository";
import {
	asArray,
	BASE,
	CHROME_WINDOWS,
	type FlowBackend,
	IPHONE,
	NEW_PASSWORD,
	newEmail,
	PASSWORD,
	str,
} from "./auth-flow";
import { pick, TestClient } from "./http";

const ACCOUNT = "/api/v1/account";
const WRONG = "Wrong-Guess-1!";

const repo = () => getAuthRepository();

export const defineAccountFlowTests = (label: string, backend: FlowBackend): void => {
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
			headers?: Record<string, string>,
		) => client.post(`${BASE}/signin`, { json: { email, password }, headers });

		const loggedIn = async (userAgent?: string) => {
			const client = browser(userAgent);
			const email = newEmail();
			expect((await signUp(client, email)).status).toBe(201);
			return { client, email };
		};

		const mailsTo = (to: string): MailMessage[] =>
			outbox.filter((message) => message.to === to);

		const tokenFromMail = (to: string): string => {
			const mail = [...outbox].reverse().find((m) => m.to === to && /token=/.test(m.text));
			const token = /token=([^\s&]+)/.exec(mail?.text ?? "")?.[1];
			if (!token) throw new Error(`no email with a token was sent to ${to}`);
			return decodeURIComponent(token);
		};

		const userIdOf = async (email: string): Promise<string> => {
			const user = await repo().findUserByEmail(email);
			if (!user) throw new Error("user not found");
			return user.id;
		};

		const verified = async (userAgent?: string) => {
			const account = await loggedIn(userAgent);
			const response = await account.client.post(`${BASE}/verify-email`, {
				json: { token: tokenFromMail(account.email) },
			});
			expect(response.status).toBe(200);
			return account;
		};

		const sessionIds = async (client: TestClient) =>
			asArray(pick((await client.get(`${BASE}/sessions`)).body, "sessions")).map(
				(session) => ({
					id: str(pick(session, "id")),
					current: pick(session, "current") === true,
				}),
			);

		const activity = async (client: TestClient, query = "") => {
			const response = await client.get(`${BASE}/activity${query}`);
			expect(response.status).toBe(200);
			return response;
		};

		const events = async (client: TestClient, query = "") =>
			asArray(pick((await activity(client, query)).body, "activity")).map((entry) =>
				str(pick(entry, "event")),
			);

		const changePassword = (
			client: TestClient,
			currentPassword: string,
			newPassword = NEW_PASSWORD,
			confirmPassword = newPassword,
		) =>
			client.post(`${BASE}/change-password`, {
				json: { currentPassword, newPassword, confirmPassword },
			});

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

		// ── Change password ──────────────────────────────────────────────────────

		describe("change password", () => {
			test("needs a signed-in user", async () => {
				const response = await changePassword(browser(), PASSWORD);
				expect(response.status).toBe(401);
			});

			test("a wrong current password is a 403 and feeds the sign-in lockout", async () => {
				const { client, email } = await loggedIn();

				for (let attempt = 0; attempt < authConfig.maxFailedLogins; attempt += 1) {
					expect((await changePassword(client, WRONG)).status).toBe(403);
				}

				// A stolen session cannot guess forever: the account is now locked.
				expect((await changePassword(client, PASSWORD)).status).toBe(429);
				expect((await signIn(browser(), email)).status).toBe(401);
				expect(await events(client)).toContain("REAUTH_FAILURE");
				expect(await events(client)).toContain("ACCOUNT_LOCKED");
			});

			test("keeps this device, ends the others, and sends a notice with the device", async () => {
				const email = newEmail();
				const laptop = browser(CHROME_WINDOWS);
				await signUp(laptop, email);
				const phone = browser(IPHONE);
				await signIn(phone, email);

				const response = await changePassword(laptop, PASSWORD);
				expect(response.status).toBe(200);
				expect(pick(response.body, "revokedSessions")).toBe(1);

				expect((await laptop.get(`${BASE}/me`)).status).toBe(200);
				expect((await phone.get(`${BASE}/me`)).status).toBe(401);

				expect((await signIn(browser(), email, PASSWORD)).status).toBe(401);
				expect((await signIn(browser(), email, NEW_PASSWORD)).status).toBe(200);

				const notice = mailsTo(email).find((mail) =>
					/password was changed/i.test(mail.subject),
				);
				expect(notice?.text).toContain("Chrome on Windows");
				expect(await events(laptop)).toContain("PASSWORD_CHANGED");
			});

			test("security notices are not blocked by the email-notifications preference", async () => {
				const { client, email } = await loggedIn();
				const preferences = await client.request("PATCH", `${ACCOUNT}/preferences`, {
					json: { emailNotifications: false },
				});
				expect(preferences.status).toBe(200);

				await changePassword(client, PASSWORD);
				expect(
					mailsTo(email).some((mail) => /password was changed/i.test(mail.subject)),
				).toBe(true);
			});

			test("validates the new password", async () => {
				const { client } = await loggedIn();

				expect((await changePassword(client, PASSWORD, PASSWORD)).status).toBe(422);
				expect(
					(await changePassword(client, PASSWORD, NEW_PASSWORD, "Different-Guess-2!"))
						.status,
				).toBe(422);
				expect((await changePassword(client, PASSWORD, "short")).status).toBe(422);
			});

			test("cancels a pending password-reset link", async () => {
				const { client, email } = await loggedIn();
				await browser().post(`${BASE}/forgot-password`, { json: { email } });
				const resetToken = tokenFromMail(email);

				await changePassword(client, PASSWORD);

				const reset = await browser().post(`${BASE}/reset-password`, {
					json: {
						token: resetToken,
						password: "Third-Horse-5-Clip!",
						confirmPassword: "Third-Horse-5-Clip!",
					},
				});
				expect(reset.status).toBe(400);
			});
		});

		// ── Change email ─────────────────────────────────────────────────────────

		describe("change email", () => {
			const requestChange = (client: TestClient, newAddress: string, password = PASSWORD) =>
				client.post(`${BASE}/change-email`, { json: { newEmail: newAddress, password } });

			const confirm = (token: string) =>
				browser().post(`${BASE}/confirm-email-change`, { json: { token } });

			test("needs the password, a different address, and a free one", async () => {
				const { client, email } = await loggedIn();
				const other = await loggedIn();

				expect((await requestChange(client, newEmail("moved"), WRONG)).status).toBe(403);
				expect((await requestChange(client, email)).status).toBe(400);
				expect((await requestChange(client, other.email)).status).toBe(409);
				expect((await requestChange(browser(), newEmail("moved"))).status).toBe(401);
			});

			test("nothing changes until the NEW address confirms; old address is warned", async () => {
				const { client, email } = await loggedIn();
				const moved = newEmail("moved");

				const response = await requestChange(client, moved);
				expect(response.status).toBe(202);

				// Link to the new mailbox...
				const link = mailsTo(moved);
				expect(link.length).toBe(1);
				expect(link[0]?.text).toContain("/confirm-email-change?token=");

				// ...and a masked warning to the old one (never the full new address).
				const warning = mailsTo(email).find((mail) =>
					/change of email address/i.test(mail.subject),
				);
				expect(warning?.text).toContain("m***@example.com");
				expect(warning?.text).not.toContain(moved);

				// Still the old address until the link is used.
				expect((await signIn(browser(), email)).status).toBe(200);
				expect((await signIn(browser(), moved)).status).toBe(401);
			});

			test("confirming switches the address, signs everything out, and is single-use", async () => {
				const { client, email } = await loggedIn();
				const moved = newEmail("moved");
				await requestChange(client, moved);
				const token = tokenFromMail(moved);

				const confirmed = await confirm(token);
				expect(confirmed.status).toBe(200);

				expect((await client.get(`${BASE}/me`)).status).toBe(401);
				expect((await signIn(browser(), email)).status).toBe(401);

				const fresh = browser();
				expect((await signIn(fresh, moved)).status).toBe(200);
				expect(pick((await fresh.get(`${BASE}/me`)).body, "user.status")).toBe("ACTIVE");

				expect(
					mailsTo(email).some((mail) => /email address was changed/i.test(mail.subject)),
				).toBe(true);
				expect((await confirm(token)).status).toBe(400);
			});

			test("a newer request replaces the older link", async () => {
				const { client } = await loggedIn();
				const first = newEmail("first");
				const second = newEmail("second");

				await requestChange(client, first);
				const firstToken = tokenFromMail(first);
				await requestChange(client, second);

				expect((await confirm(firstToken)).status).toBe(400);
				expect((await confirm(tokenFromMail(second))).status).toBe(200);
			});

			test("if the address is taken before the click, the click is a 409", async () => {
				const { client } = await loggedIn();
				const moved = newEmail("moved");
				await requestChange(client, moved);
				const token = tokenFromMail(moved);

				expect((await signUp(browser(), moved)).status).toBe(201);
				expect((await confirm(token)).status).toBe(409);
			});

			test("rejects unknown tokens", async () => {
				expect((await confirm("z".repeat(40))).status).toBe(400);
			});
		});

		// ── Profile & preferences ────────────────────────────────────────────────

		describe("profile and preferences", () => {
			const patchProfile = (client: TestClient, json: unknown) =>
				client.request("PATCH", `${ACCOUNT}/profile`, { json });

			test("every account route needs a signed-in user", async () => {
				const anonymous = browser();
				expect((await anonymous.get(`${ACCOUNT}/profile`)).status).toBe(401);
				expect((await patchProfile(anonymous, { bio: "hi" })).status).toBe(401);
				expect(
					(await anonymous.post(`${ACCOUNT}/delete`, { json: { password: PASSWORD } }))
						.status,
				).toBe(401);
			});

			test("returns the account with defaults and nothing sensitive", async () => {
				const { client, email } = await loggedIn();
				const response = await client.get(`${ACCOUNT}/profile`);

				expect(response.status).toBe(200);
				expect(pick(response.body, "user.email")).toBe(email);
				expect(pick(response.body, "preferences.theme")).toBe("system");
				expect(pick(response.body, "profile.bio")).toBeNull();

				const serialized = JSON.stringify(response.body);
				expect(serialized).not.toContain("passwordHash");
				expect(serialized).not.toContain("failedLoginAttempts");
			});

			test("updates only the fields sent, and null clears a field", async () => {
				const { client } = await loggedIn();

				const first = await patchProfile(client, {
					fullname: "Ánna Müller",
					username: `anna_${crypto.randomUUID().slice(0, 6)}`,
					bio: "Hello",
					timezone: "Europe/Berlin",
					locale: "de-DE",
					website: "https://example.com/anna",
				});
				expect(first.status).toBe(200);
				expect(pick(first.body, "user.fullname")).toBe("Ánna Müller");
				expect(pick(first.body, "profile.timezone")).toBe("Europe/Berlin");

				const second = await patchProfile(client, { bio: null });
				expect(pick(second.body, "profile.bio")).toBeNull();
				expect(pick(second.body, "profile.timezone")).toBe("Europe/Berlin");
				expect(pick(second.body, "user.fullname")).toBe("Ánna Müller");
			});

			test("rejects bad input", async () => {
				const { client } = await loggedIn();
				const bad: unknown[] = [
					{},
					{ timezone: "Mars/Olympus" },
					{ locale: "not a locale" },
					{ website: "javascript:alert(1)" },
					{ website: "http://insecure.example.com" },
					{ avatarUrl: "data:text/html,<script>1</script>" },
					{ birthDate: "2999-01-01" },
					{ username: "no spaces!" },
					{ phone: "12" },
					{ fullname: "R2D2" },
				];

				for (const body of bad) {
					expect(
						`${JSON.stringify(body)} -> ${(await patchProfile(client, body)).status}`,
					).toBe(`${JSON.stringify(body)} -> 422`);
				}
			});

			test("birth date is a calendar date: stored, returned as sent, and clearable", async () => {
				const { client } = await loggedIn();

				const set = await patchProfile(client, { birthDate: "1990-05-17" });
				expect(set.status).toBe(200);
				expect(pick(set.body, "profile.birthDate")).toBe("1990-05-17");

				const read = await client.get(`${ACCOUNT}/profile`);
				expect(pick(read.body, "profile.birthDate")).toBe("1990-05-17");

				const cleared = await patchProfile(client, { birthDate: null });
				expect(pick(cleared.body, "profile.birthDate")).toBeNull();
			});

			test("rejects impossible, malformed and future birth dates", async () => {
				const { client } = await loggedIn();
				const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

				for (const birthDate of [
					"2020-02-30",
					"17/05/1990",
					"1990-5-17",
					"yesterday",
					tomorrow,
				]) {
					const response = await patchProfile(client, { birthDate });
					expect(`${birthDate} -> ${response.status}`).toBe(`${birthDate} -> 422`);
				}
			});

			test("a taken username is a 409", async () => {
				const first = await loggedIn();
				const second = await loggedIn();
				const username = `taken_${crypto.randomUUID().slice(0, 6)}`;

				expect((await patchProfile(first.client, { username })).status).toBe(200);
				expect((await patchProfile(second.client, { username })).status).toBe(409);
			});

			test("updates preferences partially and validates them", async () => {
				const { client } = await loggedIn();

				const response = await client.request("PATCH", `${ACCOUNT}/preferences`, {
					json: { theme: "dark", reducedMotion: true },
				});
				expect(response.status).toBe(200);
				expect(pick(response.body, "preferences.theme")).toBe("dark");
				expect(pick(response.body, "preferences.reducedMotion")).toBe(true);
				expect(pick(response.body, "preferences.language")).toBe("en");

				for (const json of [
					{},
					{ theme: "neon" },
					{ language: "???" },
					{ highContrast: "yes" },
				]) {
					const bad = await client.request("PATCH", `${ACCOUNT}/preferences`, { json });
					expect(bad.status).toBe(422);
				}
			});

			test("the audit trail records which fields changed, never their values", async () => {
				const { client } = await loggedIn();
				await patchProfile(client, { bio: "very private note", phone: "+14155550123" });

				const dump = await backend.auditDump();
				expect(dump).toContain("PROFILE_UPDATED");
				expect(dump).not.toContain("very private note");
				expect(dump).not.toContain("+14155550123");
			});
		});

		// ── Delete account ───────────────────────────────────────────────────────

		describe("delete account", () => {
			const remove = (client: TestClient, password: string) =>
				client.post(`${ACCOUNT}/delete`, { json: { password } });

			test("needs the password", async () => {
				const { client, email } = await loggedIn();

				expect((await remove(client, WRONG)).status).toBe(403);
				expect(await repo().findUserByEmail(email)).toBeDefined();
			});

			test("removes the account and everything attached, and says so by email", async () => {
				const { client, email } = await loggedIn();
				const userId = await userIdOf(email);

				const response = await remove(client, PASSWORD);
				expect(response.status).toBe(200);

				expect(client.hasCookie("access_token")).toBe(false);
				expect(await repo().findUserByEmail(email)).toBeUndefined();
				expect(await repo().getUserSecurity(userId)).toBeUndefined();
				expect(await repo().getUserProfile(userId)).toBeUndefined();
				expect(await repo().listSessionsForUser(userId)).toEqual([]);

				expect((await signIn(browser(), email)).status).toBe(401);
				expect(
					mailsTo(email).some((mail) => /account was deleted/i.test(mail.subject)),
				).toBe(true);
			});

			test("the audit history survives, detached from the account", async () => {
				const { client, email } = await loggedIn();
				const userId = await userIdOf(email);
				await remove(client, PASSWORD);

				const recorded = await backend.auditEventsForSubject(userId);
				expect(recorded).toContain("SIGN_UP");
				expect(recorded).toContain("ACCOUNT_DELETED");
				expect(await repo().listAuditLogsForUser(userId, { limit: 50 })).toEqual([]);
			});
		});

		// ── Session control ──────────────────────────────────────────────────────

		describe("session control", () => {
			test("revokes exactly one other device", async () => {
				const email = newEmail();
				const laptop = browser(CHROME_WINDOWS);
				await signUp(laptop, email);
				const phoneLogin = await signIn(browser(IPHONE), email, PASSWORD, {
					"x-auth-mode": "token",
				});
				const phoneAccess = str(pick(phoneLogin.body, "tokens.accessToken"));

				const other = (await sessionIds(laptop)).find((session) => !session.current);
				const response = await laptop.request("DELETE", `${BASE}/sessions/${other?.id}`);
				expect(response.status).toBe(200);

				expect((await browser().get(`${BASE}/me`, { bearer: phoneAccess })).status).toBe(
					401,
				);
				expect((await laptop.get(`${BASE}/me`)).status).toBe(200);
				expect(await events(laptop)).toContain("SESSION_REVOKED");
			});

			test("another user's session id is simply not found", async () => {
				const mine = await loggedIn();
				const theirs = await loggedIn();
				const [theirSession] = await sessionIds(theirs.client);

				const response = await mine.client.request(
					"DELETE",
					`${BASE}/sessions/${theirSession?.id}`,
				);
				expect(response.status).toBe(404);
				expect((await theirs.client.get(`${BASE}/me`)).status).toBe(200);
			});

			test("an unknown or malformed id fails cleanly", async () => {
				const { client } = await loggedIn();

				expect(
					(await client.request("DELETE", `${BASE}/sessions/${crypto.randomUUID()}`))
						.status,
				).toBe(404);
				expect((await client.request("DELETE", `${BASE}/sessions/not-a-uuid`)).status).toBe(
					422,
				);
			});

			test("revoking the current session signs this browser out", async () => {
				const { client } = await loggedIn();
				const [current] = await sessionIds(client);

				expect(
					(await client.request("DELETE", `${BASE}/sessions/${current?.id}`)).status,
				).toBe(200);
				expect(client.hasCookie("access_token")).toBe(false);
				expect((await client.get(`${BASE}/me`)).status).toBe(401);
			});

			test("sign out everywhere else keeps only this device", async () => {
				const email = newEmail();
				const laptop = browser(CHROME_WINDOWS);
				await signUp(laptop, email);
				const others = [browser(IPHONE), browser(), browser()];
				for (const other of others) await signIn(other, email);

				const response = await laptop.post(`${BASE}/sessions/revoke-others`);
				expect(response.status).toBe(200);
				expect(pick(response.body, "revokedSessions")).toBe(3);

				for (const other of others)
					expect((await other.get(`${BASE}/me`)).status).toBe(401);
				expect((await laptop.get(`${BASE}/me`)).status).toBe(200);
				expect((await sessionIds(laptop)).length).toBe(1);
				expect(await events(laptop)).toContain("OTHER_SESSIONS_REVOKED");
			});
		});

		// ── Audit trail ──────────────────────────────────────────────────────────

		describe("audit trail", () => {
			test("a user sees their own history, newest first, without internals", async () => {
				const { client, email } = await loggedIn(CHROME_WINDOWS);
				await signIn(browser(), email, WRONG);
				await signIn(client, email);

				const response = await activity(client);
				const entries = asArray(pick(response.body, "activity"));
				const names = entries.map((entry) => str(pick(entry, "event")));

				expect(names[0]).toBe("SIGN_IN_SUCCESS");
				expect(names).toContain("SIGN_IN_FAILURE");
				expect(names[names.length - 1]).toBe("SIGN_UP");
				expect(pick(entries[0], "deviceName")).toBe("Chrome on Windows");

				const serialized = JSON.stringify(response.body);
				for (const internal of [
					"metadata",
					"userAgent",
					"emailHash",
					"reason",
					"subjectId",
				]) {
					expect(serialized).not.toContain(internal);
				}
			});

			test("only your own events are returned", async () => {
				const mine = await loggedIn();
				const theirs = await loggedIn();
				await signIn(theirs.client, theirs.email, WRONG);

				expect(await events(mine.client)).not.toContain("SIGN_IN_FAILURE");
			});

			test("pages backwards with limit and before", async () => {
				const { client, email } = await loggedIn();
				for (let index = 0; index < 4; index += 1) await signIn(browser(), email);

				const first = await activity(client, "?limit=2");
				const firstPage = asArray(pick(first.body, "activity"));
				const cursor = pick(first.body, "nextBefore");

				expect(firstPage.length).toBe(2);
				expect(typeof cursor).toBe("string");

				const second = await activity(
					client,
					`?limit=2&before=${encodeURIComponent(str(cursor))}`,
				);
				const secondIds = asArray(pick(second.body, "activity")).map((entry) =>
					pick(entry, "id"),
				);
				const firstIds = firstPage.map((entry) => pick(entry, "id"));

				expect(secondIds.length).toBeGreaterThan(0);
				expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
			});

			test("the before cursor must be an ISO timestamp, with or without an offset", async () => {
				const { client } = await loggedIn();
				const future = "2099-01-01T00:00:00";

				expect((await client.get(`${BASE}/activity?before=yesterday`)).status).toBe(422);
				expect((await client.get(`${BASE}/activity?before=2099-01-01`)).status).toBe(422);
				expect((await client.get(`${BASE}/activity?before=${future}Z`)).status).toBe(200);
				expect(
					(
						await client.get(
							`${BASE}/activity?before=${encodeURIComponent(`${future}+05:30`)}`,
						)
					).status,
				).toBe(200);
			});

			test("rejects an out-of-range limit", async () => {
				const { client } = await loggedIn();
				expect((await client.get(`${BASE}/activity?limit=0`)).status).toBe(422);
				expect((await client.get(`${BASE}/activity?limit=500`)).status).toBe(422);
			});

			test("never stores raw emails or passwords; unknown accounts get a keyed hash", async () => {
				const ghost = newEmail("ghost");
				await signIn(browser(), ghost, "Super-Secret-Guess-3!");

				const dump = await backend.auditDump();
				expect(dump).toContain("unknown_email");
				expect(dump).toContain("emailHash");
				expect(dump).not.toContain(ghost);
				expect(dump).not.toContain("Super-Secret-Guess-3!");
			});

			test("an account lock is recorded exactly once", async () => {
				const { client, email } = await loggedIn();

				for (let attempt = 0; attempt < authConfig.maxFailedLogins + 3; attempt += 1) {
					await signIn(browser(), email, WRONG);
				}

				// Reading it back needs a session that survived: use a token-mode one from before.
				const locked = (await events(client)).filter((name) => name === "ACCOUNT_LOCKED");
				expect(locked.length).toBe(1);
			});

			test("sign out and refresh-token reuse are recorded", async () => {
				const { client, email } = await loggedIn();
				const watcher = browser();
				await signIn(watcher, email);

				const sessionId = (await sessionIds(client)).find((session) => session.current)?.id;
				const stolen = str(client.cookie("refresh_token"));
				await client.post(`${BASE}/refresh`);
				await backend.backdateRotation(str(sessionId));

				const attacker = browser();
				attacker.setCookie("refresh_token", stolen, BASE);
				expect((await attacker.post(`${BASE}/refresh`)).status).toBe(401);

				const other = browser();
				await signIn(other, email);
				await other.post(`${BASE}/signout`);

				const seen = await events(watcher);
				expect(seen).toContain("REFRESH_REUSE_DETECTED");
				expect(seen).toContain("SIGN_OUT");
			});

			test("email verification and password reset are recorded", async () => {
				const { client, email } = await loggedIn();
				await client.post(`${BASE}/verify-email`, {
					json: { token: tokenFromMail(email) },
				});
				await browser().post(`${BASE}/forgot-password`, { json: { email } });
				await browser().post(`${BASE}/reset-password`, {
					json: {
						token: tokenFromMail(email),
						password: NEW_PASSWORD,
						confirmPassword: NEW_PASSWORD,
					},
				});

				const fresh = browser();
				await signIn(fresh, email, NEW_PASSWORD);
				const seen = await events(fresh);

				expect(seen).toContain("EMAIL_VERIFIED");
				expect(seen).toContain("PASSWORD_RESET_REQUESTED");
				expect(seen).toContain("PASSWORD_RESET_COMPLETED");
			});
		});

		// ── New-device alerts ────────────────────────────────────────────────────

		describe("new-device alerts", () => {
			const alerts = (to: string) =>
				mailsTo(to).filter((mail) => /new sign-in/i.test(mail.subject));

			test("a confirmed account signing in from an unseen device gets an alert", async () => {
				const { email } = await verified(CHROME_WINDOWS);

				await signIn(browser(IPHONE), email);

				const [alert] = alerts(email);
				expect(alerts(email).length).toBe(1);
				expect(alert?.text).toContain("Safari on iOS");
			});

			test("the same device again, or the sign-up device, is not new", async () => {
				const { email } = await verified(CHROME_WINDOWS);

				await signIn(browser(CHROME_WINDOWS), email);
				await signIn(browser(IPHONE), email);
				await signIn(browser(IPHONE), email);

				expect(alerts(email).length).toBe(1);
			});

			test("an unconfirmed address is never alerted", async () => {
				const { email } = await loggedIn(CHROME_WINDOWS);

				await signIn(browser(IPHONE), email);

				expect(alerts(email).length).toBe(0);
			});

			test("accounts that predate the audit trail are not flagged on their first sign-in", async () => {
				const { email } = await verified(CHROME_WINDOWS);
				await backend.wipeAudit(await userIdOf(email));

				await signIn(browser(IPHONE), email);
				expect(alerts(email).length).toBe(0);

				// From then on the trail has history, so a genuinely new device is flagged.
				await signIn(browser(CHROME_WINDOWS), email);
				expect(alerts(email).length).toBe(1);
			});
		});
	});
};
