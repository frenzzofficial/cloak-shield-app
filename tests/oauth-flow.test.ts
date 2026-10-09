import { describe, expect, test } from "bun:test";

import { callbackUrl, oauthStateCookieName } from "../src/app/auth/core/oauth-flow";
import { envClientConfig } from "../src/packages/env/client.env";

const ORIGIN = new URL(envClientConfig.CLIENT_ORIGIN).origin;

describe("callbackUrl", () => {
	test("success carries only the status and the (already sanitized) redirect", () => {
		const url = new URL(callbackUrl({ status: "success", redirect: "/dashboard?tab=1" }));

		expect(url.origin).toBe(ORIGIN);
		expect(url.pathname).toBe("/auth/callback");
		expect([...url.searchParams.keys()].sort()).toEqual(["redirect", "status"]);
		expect(url.searchParams.get("status")).toBe("success");
		// Survives the round trip through the query string intact.
		expect(url.searchParams.get("redirect")).toBe("/dashboard?tab=1");
	});

	test("an error carries only the status and a code", () => {
		const url = new URL(callbackUrl({ status: "error", error: "email_unverified" }));

		expect([...url.searchParams.keys()].sort()).toEqual(["error", "status"]);
		expect(url.searchParams.get("error")).toBe("email_unverified");
	});

	test("the host always comes from configuration, whatever the redirect says", () => {
		for (const redirect of ["/ok", "//evil.example.com", "https://evil.example.com"]) {
			expect(new URL(callbackUrl({ status: "success", redirect })).origin).toBe(ORIGIN);
		}
	});
});

describe("state cookie names", () => {
	test("each provider gets its own, so concurrent sign-ins cannot collide", () => {
		expect(oauthStateCookieName("google")).toBe("oauth_state_google");
		expect(oauthStateCookieName("discord")).not.toBe(oauthStateCookieName("google"));
	});
});
