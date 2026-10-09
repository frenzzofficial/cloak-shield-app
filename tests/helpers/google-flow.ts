// cspell:ignore Fevil Cevil Fapi
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { emailPlugin } from "@/app/auth/email/email.plugin";
import { createGooglePlugin } from "@/app/auth/google/google.plugin";
import { createApp } from "@/app/main";
import { authConfig } from "@/packages/configs/auth.config";
import { envClientConfig } from "@/packages/env/client.env";
import { type MailMessage, setMailer } from "@/packages/mailer/mailer";
import { sealOAuthState } from "@/packages/oauth/state";
import { getAuthRepository } from "@/packages/repository/drizzle/auth.repository";
import { asArray, BASE, CHROME_WINDOWS, newEmail, PASSWORD, str } from "./auth-flow";
import {
	FakeGoogle,
	type GoogleAccount,
	type TokenEndpointMode,
	type TokenOverrides,
} from "./fake-google";
import { pick, TestClient, type TestResponse } from "./http";

export interface GoogleBackend {
	install(): Promise<void> | void;
	auditDump(): Promise<string>;
}

const START = "/api/v1/auth/google/start";
const COOKIE_PATH = "/api/v1/auth/google";
const STATE_COOKIE = "oauth_state_google";
const CLIENT_ORIGIN = new URL(envClientConfig.CLIENT_ORIGIN).origin;

const repo = () => getAuthRepository();

interface Attempt {
	client: TestClient;
	start: TestResponse;
	callback: TestResponse;
	/** Where the browser ends up: the frontend, with ?status=... */
	result: URL;
}

export const defineGoogleFlowTests = (label: string, backend: GoogleBackend): void => {
	describe(label, () => {
		let google: FakeGoogle;
		let app: ReturnType<typeof createApp>;
		const outbox: MailMessage[] = [];

		const pluginFor = (
			fake: FakeGoogle,
			overrides: { enabled?: boolean; jwks?: FakeGoogle["jwks"] } = {},
		) =>
			createGooglePlugin({
				enabled: overrides.enabled ?? true,
				clientId: fake.clientId,
				clientSecret: fake.clientSecret,
				apiPublicUrl: "https://api.example.test",
				fetchImpl: fake.fetch,
				jwks: overrides.jwks ?? fake.jwks,
			});

		const account = (overrides: Partial<GoogleAccount> = {}): GoogleAccount => ({
			sub: `g-${crypto.randomUUID()}`,
			email: newEmail("gmail"),
			emailVerified: true,
			name: "Ann Lee",
			picture: "https://example.com/avatar.png",
			...overrides,
		});

		const mailsTo = (to: string) => outbox.filter((mail) => mail.to === to);

		const tokenFromMail = (to: string): string => {
			const mail = [...outbox].reverse().find((m) => m.to === to && /token=/.test(m.text));
			const token = /token=([^\s&]+)/.exec(mail?.text ?? "")?.[1];
			if (!token) throw new Error(`no email with a token was sent to ${to}`);
			return decodeURIComponent(token);
		};

		const begin = async (client: TestClient, redirect?: string) => {
			const response = await client.get(
				redirect === undefined
					? START
					: `${START}?redirect=${encodeURIComponent(redirect)}`,
			);
			expect(response.status).toBe(302);
			return { response, location: str(response.headers.get("location")) };
		};

		/** Click "Sign in with Google", sign in at Google, come back. */
		const attempt = async (
			who: GoogleAccount,
			options: {
				client?: TestClient;
				redirect?: string;
				error?: string;
				omitState?: boolean;
				mutate?: (path: string) => string;
			} = {},
		): Promise<Attempt> => {
			const client = options.client ?? new TestClient(app);
			const { response: start, location } = await begin(client, options.redirect);
			const authorized = google.authorize(location, who, {
				...(options.error === undefined ? {} : { error: options.error }),
				...(options.omitState === undefined ? {} : { omitState: options.omitState }),
			});
			const callback = await client.get(
				options.mutate ? options.mutate(authorized.path) : authorized.path,
			);

			expect(callback.status).toBe(302);
			return {
				client,
				start,
				callback,
				result: new URL(str(callback.headers.get("location"))),
			};
		};

		/** The state of things after a browser received this callback response. */
		const settle = (client: TestClient, callback: TestResponse): Attempt => ({
			client,
			start: callback,
			callback,
			result: new URL(str(callback.headers.get("location"))),
		});

		const keysOf = (url: URL) => [...url.searchParams.keys()].sort();

		const expectLanding = (url: URL) => {
			expect(url.origin).toBe(CLIENT_ORIGIN);
			expect(url.pathname).toBe("/auth/callback");
		};

		const expectSuccess = (done: Attempt, redirect = "/") => {
			expectLanding(done.result);
			expect(done.result.searchParams.get("status")).toBe("success");
			expect(done.result.searchParams.get("redirect")).toBe(redirect);
			// Nothing else may travel in the URL: no tokens, no ids, no provider data.
			expect(keysOf(done.result)).toEqual(["redirect", "status"]);
			expect(done.client.hasCookie("access_token")).toBe(true);
			expect(done.client.hasCookie("refresh_token")).toBe(true);
			expect(done.client.hasCookie(STATE_COOKIE)).toBe(false);
		};

		const expectError = (done: Attempt, code: string) => {
			expectLanding(done.result);
			expect(done.result.searchParams.get("status")).toBe("error");
			expect(done.result.searchParams.get("error")).toBe(code);
			expect(keysOf(done.result)).toEqual(["error", "status"]);
			expect(done.client.hasCookie("access_token")).toBe(false);
			expect(done.client.hasCookie("refresh_token")).toBe(false);
			// The state is single-use: spent on every outcome, including failures.
			expect(done.client.hasCookie(STATE_COOKIE)).toBe(false);
		};

		const emailAccount = async (confirmed: boolean) => {
			const client = new TestClient(app);
			const email = newEmail("local");
			const signup = await client.post(`${BASE}/signup`, {
				json: { fullname: "Local User", email, password: PASSWORD },
			});
			expect(signup.status).toBe(201);

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

		const withTokenEndpoint = async (mode: TokenEndpointMode, run: () => Promise<void>) => {
			google.tokenEndpoint = mode;
			try {
				await run();
			} finally {
				google.tokenEndpoint = "ok";
			}
		};

		const withOverride = async (override: TokenOverrides, who: GoogleAccount) => {
			google.override = override;
			return attempt(who);
		};

		beforeAll(async () => {
			await backend.install();
			google = await FakeGoogle.create();
			app = createApp({ authPlugins: [emailPlugin, pluginFor(google)] });
		});

		beforeEach(() => {
			authConfig.requireEmailVerification = false;
			google.tokenEndpoint = "ok";
			google.override = undefined;
			outbox.length = 0;
			setMailer({
				send: async (message) => {
					outbox.push(message);
				},
			});
		});

		// ── Starting ─────────────────────────────────────────────────────────────

		describe("starting a sign-in", () => {
			test("redirects to Google with every parameter Google requires", async () => {
				const { response, location } = await begin(new TestClient(app));
				const url = new URL(location);

				// FakeGoogle.authorize throws if anything Google would reject is missing or wrong.
				google.authorize(location, account());

				expect(url.searchParams.get("redirect_uri")).toBe(google.redirectUri);
				expect(url.searchParams.get("scope")).toBe("openid email profile");
				expect(url.searchParams.get("prompt")).toBe("select_account");
				expect(url.searchParams.get("code_challenge_method")).toBe("S256");
				expect((url.searchParams.get("state") ?? "").length).toBeGreaterThanOrEqual(43);
				expect((url.searchParams.get("nonce") ?? "").length).toBeGreaterThanOrEqual(43);

				// The secret is for the back channel only.
				expect(location).not.toContain(google.clientSecret);
				expect(url.searchParams.has("client_secret")).toBe(false);
				expect(response.headers.get("cache-control")).toBe("no-store");
			});

			test("sets a signed, httpOnly, path-scoped state cookie that lives ten minutes", async () => {
				const { response } = await begin(new TestClient(app));
				const cookie =
					response.setCookies.find((line) => line.startsWith(`${STATE_COOKIE}=`)) ?? "";

				expect(cookie).toMatch(/httponly/i);
				expect(cookie).toMatch(/samesite=lax/i);
				expect(cookie).toContain(`Path=${COOKIE_PATH}`);
				expect(cookie).toMatch(/max-age=600/i);
				expect((cookie.split(";")[0] ?? "").split("=")[1]?.split(".").length).toBe(3);
			});

			test("stays SameSite=Lax even when the auth cookies are configured strict", async () => {
				// "strict" would drop the cookie on the provider's cross-site redirect back, and every
				// sign-in would fail with state_invalid.
				const previous = authConfig.cookieSameSite;
				authConfig.cookieSameSite = "strict";

				try {
					const { response } = await begin(new TestClient(app));
					const cookie =
						response.setCookies.find((line) => line.startsWith(`${STATE_COOKIE}=`)) ??
						"";
					expect(cookie).toMatch(/samesite=lax/i);
				} finally {
					authConfig.cookieSameSite = previous;
				}
			});

			test("every start gets its own state, nonce and PKCE challenge", async () => {
				const params = async () => {
					const url = new URL((await begin(new TestClient(app))).location);
					return ["state", "nonce", "code_challenge"].map((name) =>
						url.searchParams.get(name),
					);
				};
				const [first, second] = [await params(), await params()];

				for (const index of [0, 1, 2]) expect(first[index]).not.toBe(second[index]);
			});

			test("keeps a safe redirect path and replaces anything that could leave the site", async () => {
				const done = await attempt(account(), {
					redirect: "/dashboard/settings?tab=security",
				});
				expectSuccess(done, "/dashboard/settings?tab=security");

				const hostile = [
					"https://evil.example.com",
					"//evil.example.com",
					"/\\evil.example.com",
					"/%2Fevil.example.com",
					"javascript:alert(1)",
					"/\t/evil.example.com",
				];
				for (const redirect of hostile) {
					const result = await attempt(account(), { redirect });
					expect(`${redirect} -> ${result.result.searchParams.get("redirect")}`).toBe(
						`${redirect} -> /`,
					);
					expect(result.result.origin).toBe(CLIENT_ORIGIN);
				}
			});
		});

		// ── Signing in ───────────────────────────────────────────────────────────

		describe("signing in", () => {
			test("creates and signs in a new account", async () => {
				const who = account({ name: "Ánna Müller" });
				const done = await attempt(who);

				expectSuccess(done);

				const me = await done.client.get(`${BASE}/me`);
				expect(me.status).toBe(200);
				expect(pick(me.body, "user.email")).toBe(who.email);
				expect(pick(me.body, "user.status")).toBe("ACTIVE");
				expect(pick(me.body, "user.hasPassword")).toBe(false);

				const user = await repo().findUserByEmail(who.email ?? "");
				expect(user?.fullname).toBe("Ánna Müller");
				expect(user?.avatarUrl).toBe("https://example.com/avatar.png");
				expect(user?.emailVerifiedAt).not.toBeNull();

				const links = await repo().listOAuthAccountsForUser(user?.id ?? "");
				expect(links.map((link) => [link.provider, link.providerUserId])).toEqual([
					["GOOGLE", who.sub],
				]);

				const rows = await repo().listAuditLogsForUser(user?.id ?? "", { limit: 20 });
				const signIn = rows.find((row) => row.event === "SIGN_IN_SUCCESS");
				expect(signIn?.metadata.provider).toBe("GOOGLE");
				expect(signIn?.metadata.outcome).toBe("created");
				expect(rows.some((row) => row.event === "SIGN_UP")).toBe(true);
			});

			test("redeems the code with the PKCE verifier and the secret, over the back channel only", async () => {
				google.tokenCalls.length = 0;
				await attempt(account());

				const call = google.tokenCalls[0];
				expect(call?.grant_type).toBe("authorization_code");
				expect(call?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
				expect(call?.client_secret).toBe(google.clientSecret);
				expect(call?.redirect_uri).toBe(google.redirectUri);
			});

			test("a returning user lands in the same account", async () => {
				const who = account();
				const first = await attempt(who);
				const user = await repo().findUserByEmail(who.email ?? "");
				const before = (await repo().findOAuthAccount("GOOGLE", who.sub))?.lastLoginAt;

				await Bun.sleep(15);
				const again = await attempt(who);

				expectSuccess(first);
				expectSuccess(again);
				expect((await repo().findUserByEmail(who.email ?? ""))?.id).toBe(user?.id);
				expect((await repo().listOAuthAccountsForUser(user?.id ?? "")).length).toBe(1);

				const after = (await repo().findOAuthAccount("GOOGLE", who.sub))?.lastLoginAt;
				expect(after && before && after.getTime() > before.getTime()).toBe(true);
				// Nothing was "connected": nobody gets that email for an ordinary return visit.
				expect(
					mailsTo(who.email ?? "").some((mail) => /connected/i.test(mail.subject)),
				).toBe(false);
			});

			test("links to an existing CONFIRMED email account, keeps its password, and tells the owner", async () => {
				const local = await emailAccount(true);
				const done = await attempt(account({ email: local.email }), {
					client: new TestClient(app, { "user-agent": CHROME_WINDOWS }),
				});

				expectSuccess(done);
				const links = await repo().listOAuthAccountsForUser(local.user.id);
				expect(links.length).toBe(1);

				// Same account, both ways in.
				const viaPassword = new TestClient(app);
				expect(
					(
						await viaPassword.post(`${BASE}/signin`, {
							json: { email: local.email, password: PASSWORD },
						})
					).status,
				).toBe(200);
				expect(pick((await done.client.get(`${BASE}/me`)).body, "user.hasPassword")).toBe(
					true,
				);

				const notice = mailsTo(local.email).find((mail) =>
					/Google was connected/i.test(mail.subject),
				);
				expect(notice?.text).toContain("Chrome on Windows");
			});

			test("RECLAIMS an unconfirmed email account: its password and sessions die", async () => {
				const local = await emailAccount(false);
				expect((await local.client.get(`${BASE}/me`)).status).toBe(200);

				const done = await attempt(account({ email: local.email }));

				expectSuccess(done);
				expect((await local.client.get(`${BASE}/me`)).status).toBe(401);
				expect(
					(
						await new TestClient(app).post(`${BASE}/signin`, {
							json: { email: local.email, password: PASSWORD },
						})
					).status,
				).toBe(401);
				expect(pick((await done.client.get(`${BASE}/me`)).body, "user.status")).toBe(
					"ACTIVE",
				);
				expect(
					mailsTo(local.email).some((mail) => /Google was connected/i.test(mail.subject)),
				).toBe(true);
			});

			test("opens a long session and the user can sign out of it", async () => {
				const done = await attempt(account());
				const sessions = await done.client.get(`${BASE}/sessions`);
				const [session] = asArray(pick(sessions.body, "sessions"));

				const lifetime =
					(new Date(str(pick(session, "expiresAt"))).getTime() -
						new Date(str(pick(session, "createdAt"))).getTime()) /
					1_000;
				// The database stamps createdAt with its own clock, so allow a second of skew.
				expect(Math.abs(lifetime - authConfig.longSessionTtlSeconds)).toBeLessThan(2);

				expect((await done.client.post(`${BASE}/signout`)).status).toBe(200);
				expect((await done.client.get(`${BASE}/me`)).status).toBe(401);
			});

			test("the client secret appears in no redirect, no response body, and no audit row", async () => {
				const done = await attempt(account());
				const seen = [
					str(done.start.headers.get("location")),
					str(done.callback.headers.get("location")),
					JSON.stringify(done.start.body ?? ""),
					JSON.stringify(done.callback.body ?? ""),
					...done.start.setCookies,
					await backend.auditDump(),
				].join("\n");

				expect(seen).not.toContain(google.clientSecret);
			});
		});

		// ── Callbacks that must be refused ───────────────────────────────────────

		describe("refusing a callback", () => {
			test("anything that is not a flow WE started is state_invalid", async () => {
				const stateOf = (location: string) =>
					new URL(location).searchParams.get("state") ?? "";
				const sealed = (state: string, provider = "google", ttl?: number) =>
					sealOAuthState(
						{ provider, state, nonce: "n", verifier: "v".repeat(43), redirect: "/" },
						ttl,
					);

				const cases: Record<
					string,
					(client: TestClient, location: string) => Promise<void> | void
				> = {
					"no cookie at all": (client) => client.dropCookie(STATE_COOKIE),
					"a tampered cookie": (client) => {
						const value = client.cookie(STATE_COOKIE) ?? "";
						client.setCookie(STATE_COOKIE, `${value.slice(0, -3)}AAA`, COOKIE_PATH);
					},
					"an expired cookie": async (client, location) =>
						client.setCookie(
							STATE_COOKIE,
							await sealed(stateOf(location), "google", -5),
							COOKIE_PATH,
						),
					"a cookie from another provider's flow": async (client, location) =>
						client.setCookie(
							STATE_COOKIE,
							await sealed(stateOf(location), "discord"),
							COOKIE_PATH,
						),
					"a cookie for a different state": async (client) =>
						client.setCookie(
							STATE_COOKIE,
							await sealed("some-other-state"),
							COOKIE_PATH,
						),
				};

				for (const [name, tamper] of Object.entries(cases)) {
					const client = new TestClient(app);
					const { location } = await begin(client);
					await tamper(client, location);
					const authorized = google.authorize(location, account());
					const done = settle(client, await client.get(authorized.path));

					expect(`${name}: ${done.result.searchParams.get("error")}`).toBe(
						`${name}: state_invalid`,
					);
					expectError(done, "state_invalid");
				}
			});

			test("a state that does not match the URL, or is missing from it, is state_invalid", async () => {
				const mismatch = await attempt(account(), {
					mutate: (path) => path.replace(/state=[^&]+/, "state=forged-state-value"),
				});
				expectError(mismatch, "state_invalid");

				const missing = await attempt(account(), { omitState: true });
				expectError(missing, "state_invalid");
			});

			test("pressing Cancel at Google is access_denied; other provider errors are provider_error", async () => {
				expectError(await attempt(account(), { error: "access_denied" }), "access_denied");
				expectError(await attempt(account(), { error: "server_error" }), "provider_error");
				expectError(
					await attempt(account(), { error: "<script>alert(1)</script>" }),
					"provider_error",
				);

				const noCode = await attempt(account(), {
					mutate: (path) => path.replace(/code=[^&]+&/, ""),
				});
				expectError(noCode, "provider_error");
			});

			test("a callback cannot be replayed, by the same browser or by anyone holding the URL", async () => {
				const client = new TestClient(app);
				const { location } = await begin(client);
				const authorized = google.authorize(location, account());

				const first = await client.get(authorized.path);
				expect(new URL(str(first.headers.get("location"))).searchParams.get("status")).toBe(
					"success",
				);

				// Same browser, same URL: the state cookie was spent by the first visit.
				const again = settle(client, await client.get(authorized.path));
				expect(again.result.searchParams.get("status")).toBe("error");
				expect(again.result.searchParams.get("error")).toBe("state_invalid");

				// Someone who copied the URL (history, a proxy log, a referrer) has no state cookie at all.
				const thief = new TestClient(app);
				expectError(settle(thief, await thief.get(authorized.path)), "state_invalid");
			});

			test("an old code with a fresh state fails the exchange, and so does a code from another login", async () => {
				// 1. A code that was already spent.
				const first = new TestClient(app);
				const startFirst = await begin(first);
				const spent = google.authorize(startFirst.location, account());
				await first.get(spent.path);

				const second = new TestClient(app);
				const startSecond = await begin(second);
				const fresh = google.authorize(startSecond.location, account());
				const replay = fresh.path.replace(/code=[^&]+/, `code=${spent.code}`);
				expectError(settle(second, await second.get(replay)), "exchange_failed");

				// 2. A valid code, but issued against ANOTHER login's PKCE challenge.
				const a = new TestClient(app);
				const b = new TestClient(app);
				const locationA = (await begin(a)).location;
				const locationB = (await begin(b)).location;
				const authA = google.authorize(locationA, account());
				const authB = google.authorize(locationB, account());
				const swapped = await a.get(authA.path.replace(/code=[^&]+/, `code=${authB.code}`));
				expectError(settle(a, swapped), "exchange_failed");
			});

			test("a broken token endpoint is exchange_failed, however it breaks", async () => {
				for (const mode of ["http500", "network", "garbage", "no_id_token"] as const) {
					await withTokenEndpoint(mode, async () => {
						const done = await attempt(account());
						expect(`${mode}: ${done.result.searchParams.get("error")}`).toBe(
							`${mode}: exchange_failed`,
						);
						expectError(done, "exchange_failed");
					});
				}
			});

			test("an ID token that fails any check is token_invalid", async () => {
				const bad: Record<string, TokenOverrides> = {
					"another app's audience": { audience: "someone-elses-client-id" },
					"a foreign issuer": { issuer: "https://evil.example.com" },
					"an expired token": { expiresIn: -60 },
					"another login's nonce": { nonce: "a-nonce-from-some-other-login" },
					"no nonce": { nonce: null },
					"a signature from an unpublished key": { signWith: "attacker" },
					"HS256 instead of RS256": { alg: "HS256" },
					"several audiences without our azp": {
						audience: [google.clientId, "another-app"],
					},
				};

				for (const [name, override] of Object.entries(bad)) {
					const done = await withOverride(override, account());
					expect(`${name}: ${done.result.searchParams.get("error")}`).toBe(
						`${name}: token_invalid`,
					);
					expectError(done, "token_invalid");
				}
			});

			test("a Google key-set outage is token_invalid and leaks nothing", async () => {
				const outage = createApp({
					authPlugins: [
						emailPlugin,
						pluginFor(google, {
							jwks: async () => {
								throw new Error("getaddrinfo ENOTFOUND www.googleapis.com");
							},
						}),
					],
				});
				const client = new TestClient(outage);
				const { location } = await begin(client);
				const callback = await client.get(google.authorize(location, account()).path);
				const result = new URL(str(callback.headers.get("location")));

				expect(result.searchParams.get("error")).toBe("token_invalid");
				expect(result.toString()).not.toContain("ENOTFOUND");
			});

			test("an email Google has not verified is refused, and creates nothing", async () => {
				for (const emailVerified of [false, "false", "yes", undefined]) {
					const who = account({ emailVerified });
					const done = await attempt(who);

					expectError(done, "email_unverified");
					expect(await repo().findUserByEmail(who.email ?? "")).toBeUndefined();
					expect(await repo().findOAuthAccount("GOOGLE", who.sub)).toBeUndefined();
				}
			});

			test("the dangerous case: an UNVERIFIED claim on a victim's confirmed address links nothing", async () => {
				const victim = await emailAccount(true);
				const done = await attempt(account({ email: victim.email, emailVerified: false }));

				expectError(done, "email_unverified");
				expect(await repo().listOAuthAccountsForUser(victim.user.id)).toEqual([]);
				expect((await victim.client.get(`${BASE}/me`)).status).toBe(200);
			});

			test("a token with no email is email_missing", async () => {
				expectError(await attempt(account({ email: undefined })), "email_missing");
			});

			test("Google sending email_verified as the string 'true' is accepted", async () => {
				expectSuccess(await attempt(account({ emailVerified: "true" })));
			});

			test("suspended accounts are refused, via the link and via the email", async () => {
				const who = account();
				await attempt(who);
				const user = await repo().findUserByEmail(who.email ?? "");
				if (!user) throw new Error("user missing");
				await repo().updateUser({ ...user, status: "SUSPENDED" });
				expectError(await attempt(who), "account_blocked");

				const local = await emailAccount(true);
				await repo().updateUser({ ...local.user, status: "SUSPENDED" });
				expectError(await attempt(account({ email: local.email })), "account_blocked");
				expect(await repo().listOAuthAccountsForUser(local.user.id)).toEqual([]);
			});

			test("a second Google account claiming an already-linked address is provider_conflict", async () => {
				const first = account();
				await attempt(first);

				expectError(await attempt(account({ email: first.email })), "provider_conflict");
			});

			test("every refusal is audited with its reason, and the trail holds nothing it should not", async () => {
				await attempt(account(), { error: "access_denied" });
				await attempt(account({ emailVerified: false }));
				await withOverride({ audience: "another-app" }, account());

				const dump = await backend.auditDump();
				for (const reason of ["access_denied", "email_unverified", "token_invalid"]) {
					expect(dump).toContain(`"reason":"${reason}"`);
				}
				expect(dump).toContain('"provider":"GOOGLE"');
				expect(dump).not.toContain(google.clientSecret);
				expect(dump).not.toContain("code-");
				expect(dump).not.toContain("eyJ");
			});
		});

		// ── Wiring ───────────────────────────────────────────────────────────────

		describe("wiring", () => {
			test("an enabled Google is listed for the frontend, with the path its button should open", async () => {
				const response = await new TestClient(app).get("/api/v1/auth/providers");

				expect(pick(response.body, "providers")).toEqual([
					{ id: "email", kind: "password", label: "Email and password" },
					{ id: "google", kind: "oauth", label: "Google", startPath: START },
				]);
			});

			test("a disabled Google has no routes at all", async () => {
				const off = createApp({
					authPlugins: [emailPlugin, pluginFor(google, { enabled: false })],
				});
				const client = new TestClient(off);

				expect((await client.get(START)).status).toBe(404);
				expect((await client.get(`${COOKIE_PATH}/callback`)).status).toBe(404);
				expect(
					JSON.stringify((await client.get("/api/v1/auth/providers")).body),
				).not.toContain("google");
			});

			test("Google without anything that can refresh and sign out fails at boot", async () => {
				expect(() =>
					createApp({
						authPlugins: [{ ...emailPlugin, enabled: false }, pluginFor(google)],
					}),
				).toThrow(/needs "session-routes"/);
			});
		});
	});
};
