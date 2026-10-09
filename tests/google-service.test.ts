import { describe, expect, test } from "bun:test";
import { createLocalJWKSet } from "jose";

import { startGoogleLogin } from "../src/app/auth/google/google.services";
import { unsealOAuthState } from "../src/packages/oauth/state";

// The callback re-checks the redirect, so a broken sanitizer at START would be invisible in the
// end-to-end flow. Each layer is tested on its own, so one cannot quietly cover for the other.

const deps = {
	clientId: "id.apps.googleusercontent.com",
	clientSecret: "secret",
	redirectUri: "https://api.example.test/api/v1/auth/google/callback",
	jwks: createLocalJWKSet({ keys: [] }),
};

describe("startGoogleLogin", () => {
	const redirectInState = async (input: unknown) => {
		const { sealedState } = await startGoogleLogin(deps, input);
		return (await unsealOAuthState(sealedState))?.redirect;
	};

	test("stores a safe redirect path as given", async () => {
		expect(await redirectInState("/dashboard?tab=1")).toBe("/dashboard?tab=1");
	});

	test("never stores a redirect that could leave the site", async () => {
		const hostile = [
			"https://evil.example.com",
			"//evil.example.com",
			"/\\evil.example.com",
			"javascript:alert(1)",
			undefined,
			42,
		];

		for (const input of hostile) {
			expect(`${String(input)} -> ${await redirectInState(input)}`).toBe(
				`${String(input)} -> /`,
			);
		}
	});

	test("the state carries the provider, a verifier matching the challenge, and the same state and nonce as the URL", async () => {
		const { location, sealedState } = await startGoogleLogin(deps, "/x");
		const url = new URL(location);
		const saved = await unsealOAuthState(sealedState);

		expect(saved?.provider).toBe("google");
		expect(saved?.state).toBe(url.searchParams.get("state") ?? undefined);
		expect(saved?.nonce).toBe(url.searchParams.get("nonce") ?? undefined);
		expect(saved?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		// The verifier itself must never be in the URL; only its hash.
		expect(location).not.toContain(saved?.verifier ?? "unreachable");
	});
});
