import { describe, expect, test } from "bun:test";

import { parseOAuthEnv } from "@/packages/env/oauth.env";

const google = {
	ENABLE_GOOGLE_AUTH: "true",
	GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
	GOOGLE_CLIENT_SECRET: "secret",
	API_PUBLIC_URL: "https://api.example.com",
};

describe("OAuth env", () => {
	test("a deployment that does not use Google needs none of it", () => {
		const env = parseOAuthEnv({});

		expect(env.ENABLE_GOOGLE_AUTH).toBe(false);
		expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
		expect(env.API_PUBLIC_URL).toBeUndefined();
		expect(env.OAUTH_CALLBACK_PATH).toBe("/auth/callback");
	});

	test("turning Google on requires the id, the secret and the public URL, and names what is missing", () => {
		for (const missing of [
			"GOOGLE_CLIENT_ID",
			"GOOGLE_CLIENT_SECRET",
			"API_PUBLIC_URL",
		] as const) {
			const source: Record<string, string | undefined> = { ...google, [missing]: undefined };
			expect(() => parseOAuthEnv(source)).toThrow(new RegExp(`${missing} is required`));
		}
		expect(parseOAuthEnv(google).ENABLE_GOOGLE_AUTH).toBe(true);
	});

	test("blank values count as missing", () => {
		expect(() => parseOAuthEnv({ ...google, GOOGLE_CLIENT_SECRET: "   " })).toThrow();
	});

	test("the public URL loses its trailing slash, so the redirect URI is built exactly", () => {
		expect(
			parseOAuthEnv({ ...google, API_PUBLIC_URL: "https://api.example.com/" }).API_PUBLIC_URL,
		).toBe("https://api.example.com");
		expect(
			parseOAuthEnv({ ...google, API_PUBLIC_URL: "https://api.example.com///" })
				.API_PUBLIC_URL,
		).toBe("https://api.example.com");
		expect(
			parseOAuthEnv({ ...google, API_PUBLIC_URL: "https://example.com/backend/" })
				.API_PUBLIC_URL,
		).toBe("https://example.com/backend");
	});

	test("an invalid public URL is rejected", () => {
		for (const value of ["api.example.com", "not a url", "/relative"]) {
			expect(() => parseOAuthEnv({ ...google, API_PUBLIC_URL: value })).toThrow();
		}
	});

	test("production requires https, except for a local address", () => {
		const production = { ...google, NODE_ENV: "production" };

		expect(() =>
			parseOAuthEnv({ ...production, API_PUBLIC_URL: "http://api.example.com" }),
		).toThrow(/must use https in production/);
		expect(
			parseOAuthEnv({ ...production, API_PUBLIC_URL: "https://api.example.com" }).NODE_ENV,
		).toBe("production");
		expect(
			parseOAuthEnv({ ...production, API_PUBLIC_URL: "http://localhost:3000" }).NODE_ENV,
		).toBe("production");
		expect(
			parseOAuthEnv({ ...google, API_PUBLIC_URL: "http://api.example.com" }).API_PUBLIC_URL,
		).toBe("http://api.example.com");
	});

	test("the callback path must be a path on the frontend, never a host", () => {
		expect(parseOAuthEnv({ OAUTH_CALLBACK_PATH: "/login/done" }).OAUTH_CALLBACK_PATH).toBe(
			"/login/done",
		);

		for (const value of ["//evil.example.com", "login", "https://evil.example.com"]) {
			expect(() => parseOAuthEnv({ OAUTH_CALLBACK_PATH: value })).toThrow(
				/OAUTH_CALLBACK_PATH/,
			);
		}
	});
});
