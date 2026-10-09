import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
	type AuthCore,
	type AuthPlugin,
	createAuthCore,
	mountAuthPlugins,
} from "../src/app/auth/core/plugin";
import { registerAuthPlugins } from "../src/app/auth/plugins";
import { createApp } from "../src/app/main";
import { registerIdentityRoutes } from "../src/app/routes";
import { registerErrorHandler } from "../src/packages/middlewares/error-handler";
import { setAuthRepository } from "../src/packages/repository/drizzle/auth.repository";
import type { User } from "../src/packages/schema/user.schema";
import { verifyAccessToken } from "../src/packages/utils/auth";
import { pick, TestClient } from "./helpers/http";
import { InMemoryAuthRepository } from "./helpers/memory-repo";

const PROVIDERS = "/api/v1/auth/providers";

const fakePlugin = (overrides: Partial<AuthPlugin> = {}): AuthPlugin => ({
	id: "google",
	kind: "oauth",
	label: "Fake Google",
	enabled: true,
	register: () => undefined,
	...overrides,
});

describe("auth plugin registry", () => {
	test("registers enabled plugins and hands each one the core", () => {
		const received: AuthCore[] = [];
		const app = new Elysia();

		const mounted = mountAuthPlugins(app, [
			fakePlugin({ register: (_app, core) => void received.push(core) }),
		]);

		expect(mounted.map((plugin) => plugin.id)).toEqual(["google"]);
		expect(received.length).toBe(1);
		expect(Object.isFrozen(received[0])).toBe(true);
	});

	test("a disabled plugin registers nothing and is not listed", async () => {
		let registered = false;
		const app = new Elysia();

		const mounted = mountAuthPlugins(app, [
			fakePlugin({
				id: "discord",
				enabled: false,
				register: () => {
					registered = true;
				},
			}),
			fakePlugin({ id: "google", label: "Google" }),
		]);

		expect(registered).toBe(false);
		expect(mounted.map((plugin) => plugin.id)).toEqual(["google"]);

		const response = await new TestClient(app).get(PROVIDERS);
		expect(response.status).toBe(200);
		expect(JSON.stringify(response.body)).not.toContain("discord");
	});

	test("two plugins with one id fail at boot instead of shadowing each other", () => {
		expect(() =>
			mountAuthPlugins(new Elysia(), [fakePlugin(), fakePlugin({ label: "Other" })]),
		).toThrow(/registered twice/);
	});

	test("with every plugin disabled the listing is empty, not an error", async () => {
		const app = new Elysia();
		const mounted = mountAuthPlugins(app, [fakePlugin({ enabled: false })]);

		expect(mounted).toEqual([]);
		const response = await new TestClient(app).get(PROVIDERS);
		expect(pick(response.body, "providers")).toEqual([]);
	});

	test("the listing exposes only id, kind and label", async () => {
		const app = new Elysia();
		mountAuthPlugins(app, [fakePlugin({ register: () => undefined })]);

		const response = await new TestClient(app).get(PROVIDERS);
		expect(pick(response.body, "providers")).toEqual([
			{ id: "google", kind: "oauth", label: "Fake Google" },
		]);
	});

	test("the real app offers email by default", async () => {
		const response = await new TestClient(createApp()).get(PROVIDERS);

		expect(response.status).toBe(200);
		expect(pick(response.body, "providers")).toEqual([
			{ id: "email", kind: "password", label: "Email and password" },
		]);
	});

	test("the composition root takes a custom plugin list", () => {
		const mounted = registerAuthPlugins(new Elysia(), [
			fakePlugin({ id: "discord", kind: "oauth" }),
		]);
		expect(mounted.map((plugin) => plugin.id)).toEqual(["discord"]);
	});
});

describe("AuthCore", () => {
	test("exposes the surface plugins are allowed to rely on", () => {
		const core = createAuthCore();

		expect(typeof core.sessions.start).toBe("function");
		expect(typeof core.sessions.isBlocked).toBe("function");
		expect(typeof core.audit.record).toBe("function");
		expect(typeof core.cookies.set).toBe("function");
		expect(typeof core.cookies.clear).toBe("function");
		expect(typeof core.cookies.readRefreshToken).toBe("function");
		expect(typeof core.cookies.wantsTokensInBody).toBe("function");
		expect(typeof core.device.extract).toBe("function");
		expect(typeof core.reauth.require).toBe("function");
		expect(typeof core.identities.resolve).toBe("function");
		expect(typeof core.oauth.setStateCookie).toBe("function");
		expect(typeof core.oauth.takeStateCookie).toBe("function");
		expect(typeof core.oauth.callbackUrl).toBe("function");
	});
});

// The point of the whole design: a sign-in method that is NOT email can sign someone in using
// nothing but AuthCore. This is the shape the Google plugin will have.
describe("a non-email plugin built only on AuthCore", () => {
	const memory = new InMemoryAuthRepository();
	const now = new Date();
	const user: User = {
		id: crypto.randomUUID(),
		fullname: "Fake User",
		email: "fake-user@example.com",
		avatarUrl: null,
		role: "USER",
		status: "ACTIVE",
		emailVerifiedAt: now,
		createdAt: now,
		updatedAt: now,
	};

	const providerPlugin: AuthPlugin = {
		id: "google",
		kind: "oauth",
		label: "Fake provider",
		enabled: true,
		register: (app, core) => {
			app.get("/fake-provider/callback", async ({ cookie, request, server, status }) => {
				const device = core.device.extract(request, server);
				const login = await core.sessions.start(user, device, {
					remember: true,
					metadata: { provider: "fake" },
				});

				core.cookies.set(cookie, login.tokens, login.session.expiresAt);
				return status(200, { success: true, sessionId: login.session.id });
			});
		},
	};

	beforeAll(async () => {
		setAuthRepository(memory);
		await memory.createUserWithSession({
			user,
			security: {
				userId: user.id,
				passwordHash: "x",
				twoFactorEnabled: false,
				failedLoginAttempts: 0,
				lockedUntil: null,
				lastPasswordChangedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			profile: {
				userId: user.id,
				username: null,
				bio: null,
				phone: null,
				birthDate: null,
				gender: null,
				timezone: null,
				locale: null,
				website: null,
				twitterUrl: null,
				githubUrl: null,
				linkedinUrl: null,
				createdAt: now,
				updatedAt: now,
			},
			preferences: {
				userId: user.id,
				theme: "system",
				language: "en",
				emailNotifications: true,
				pushNotifications: true,
				marketingEmails: false,
				reducedMotion: false,
				highContrast: false,
				createdAt: now,
				updatedAt: now,
			},
		});
	});

	afterAll(() => setAuthRepository(null));

	test("creates a real session, sets cookies, and leaves an audit row naming the provider", async () => {
		const app = new Elysia();
		mountAuthPlugins(app, [providerPlugin]);
		const client = new TestClient(app);

		const response = await client.get("/fake-provider/callback");
		expect(response.status).toBe(200);

		// Cookies came from core.cookies, and the access token is a genuine one for that session.
		expect(response.setCookies.some((line) => line.startsWith("access_token="))).toBe(true);
		expect(response.setCookies.some((line) => line.startsWith("refresh_token="))).toBe(true);
		const claims = await verifyAccessToken(client.cookie("access_token") ?? "");
		expect(claims.userId).toBe(user.id);
		expect(pick(response.body, "sessionId")).toBe(claims.sessionId);

		const stored = await memory.getSession(claims.sessionId);
		expect(stored?.userId).toBe(user.id);

		const audit = memory.allAuditLogs().find((entry) => entry.event === "SIGN_IN_SUCCESS");
		expect(audit?.userId).toBe(user.id);
		expect(audit?.metadata.provider).toBe("fake");
		expect(audit?.metadata.remember).toBe(true);
	});
});

describe("account routes depend on having a way to sign in", () => {
	const build = (plugins: readonly AuthPlugin[]) => {
		const app = new Elysia();
		registerErrorHandler(app);
		registerIdentityRoutes(app, plugins);
		return new TestClient(app);
	};

	test("with an enabled plugin the account routes exist (and ask for a session)", async () => {
		const response = await build([fakePlugin()]).get("/api/v1/account/profile");
		expect(response.status).toBe(401);
	});

	test("with every plugin disabled there is nothing to sign in with, so no account routes", async () => {
		const response = await build([fakePlugin({ enabled: false })]).get(
			"/api/v1/account/profile",
		);
		expect(response.status).toBe(404);
	});
});

describe("plugin capabilities", () => {
	const provider = (overrides: Partial<AuthPlugin> = {}) =>
		fakePlugin({
			id: "email",
			kind: "password",
			label: "Email",
			provides: ["session-routes"],
			...overrides,
		});
	const needy = (overrides: Partial<AuthPlugin> = {}) =>
		fakePlugin({ id: "google", label: "Google", requires: ["session-routes"], ...overrides });

	test("a requirement met by an enabled plugin boots", () => {
		const mounted = mountAuthPlugins(new Elysia(), [provider(), needy()]);
		expect(mounted.map((plugin) => plugin.id)).toEqual(["email", "google"]);
	});

	test("an unmet requirement fails at boot and says what is missing", () => {
		expect(() => mountAuthPlugins(new Elysia(), [needy()])).toThrow(/needs "session-routes"/);
	});

	test("a DISABLED provider does not count", () => {
		expect(() =>
			mountAuthPlugins(new Elysia(), [provider({ enabled: false }), needy()]),
		).toThrow(/needs "session-routes"/);
	});

	test("a disabled plugin's own requirements are not checked", () => {
		expect(mountAuthPlugins(new Elysia(), [needy({ enabled: false })])).toEqual([]);
	});

	test("startPath is advertised only by methods that have one", async () => {
		const app = new Elysia();
		mountAuthPlugins(app, [provider(), needy({ startPath: "/api/v1/auth/google/start" })]);

		const response = await new TestClient(app).get(PROVIDERS);
		expect(pick(response.body, "providers")).toEqual([
			{ id: "email", kind: "password", label: "Email" },
			{
				id: "google",
				kind: "oauth",
				label: "Google",
				startPath: "/api/v1/auth/google/start",
			},
		]);
	});
});
