// cspell:ignore Fevil Cevil Fapi
import { describe, expect, test } from "bun:test";
import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	type JWK,
	type JWTPayload,
	SignJWT,
} from "jose";

import { ProviderHttpError, postForm } from "@/packages/oauth/http";
import { IdTokenError, verifyIdToken } from "@/packages/oauth/oidc";
import {
	codeChallengeS256,
	generateCodeVerifier,
	generateRandomToken,
} from "@/packages/oauth/pkce";
import { safeRedirectPath } from "@/packages/oauth/redirect";
import {
	type OAuthStatePayload,
	safeEqual,
	sealOAuthState,
	unsealOAuthState,
} from "@/packages/oauth/state";
import { signAccessToken } from "@/packages/utils/auth";

describe("PKCE", () => {
	test("matches the RFC 7636 appendix B test vector", () => {
		expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
	});

	test("verifiers are 43 URL-safe characters and never repeat", () => {
		const seen = new Set<string>();
		for (let index = 0; index < 50; index += 1) {
			const verifier = generateCodeVerifier();
			expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
			seen.add(verifier);
		}
		expect(seen.size).toBe(50);
	});

	test("state/nonce values are long, URL-safe and unique", () => {
		const a = generateRandomToken();
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(a).not.toBe(generateRandomToken());
	});
});

describe("signed OAuth state", () => {
	const payload: OAuthStatePayload = {
		provider: "google",
		state: "state-value",
		nonce: "nonce-value",
		verifier: "verifier-value",
		redirect: "/dashboard?tab=1",
	};

	test("round-trips every field", async () => {
		expect(await unsealOAuthState(await sealOAuthState(payload))).toEqual(payload);
	});

	test("an expired state is rejected", async () => {
		expect(await unsealOAuthState(await sealOAuthState(payload, -5))).toBeNull();
	});

	test("a tampered state is rejected, whichever part is touched", async () => {
		const [header, body, signature] = (await sealOAuthState(payload)).split(".");
		const flip = (part: string | undefined) =>
			`${(part ?? "").slice(0, -2)}${(part ?? "").endsWith("AA") ? "BB" : "AA"}`;

		expect(await unsealOAuthState(`${flip(header)}.${body}.${signature}`)).toBeNull();
		expect(await unsealOAuthState(`${header}.${flip(body)}.${signature}`)).toBeNull();
		expect(await unsealOAuthState(`${header}.${body}.${flip(signature)}`)).toBeNull();
	});

	test("a token signed with some other secret is rejected", async () => {
		const forged = await new SignJWT({ ...payload })
			.setProtectedHeader({ alg: "HS256" })
			.setIssuer("cloak-shield:oauth-state")
			.setAudience("oauth-state")
			.setExpirationTime("5m")
			.sign(new TextEncoder().encode("an-attacker-chosen-secret-0123456789"));

		expect(await unsealOAuthState(forged)).toBeNull();
	});

	test("an access token is not a state token", async () => {
		const access = await signAccessToken({
			userId: "u",
			email: "a@b.co",
			role: "USER",
			sessionId: "s",
		});
		expect(await unsealOAuthState(access)).toBeNull();
	});

	test("unsigned, empty and garbage input is rejected without throwing", async () => {
		const unsigned = `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify(payload))}.`;
		for (const value of [unsigned, "", "garbage", "a.b.c", "....", "\u0000"]) {
			expect(await unsealOAuthState(value)).toBeNull();
		}
	});

	test("safeEqual compares in constant time and handles length differences", () => {
		expect(safeEqual("abc", "abc")).toBe(true);
		expect(safeEqual("abc", "abd")).toBe(false);
		expect(safeEqual("abc", "abcd")).toBe(false);
		expect(safeEqual("", "")).toBe(true);
	});
});

describe("safeRedirectPath", () => {
	test("keeps ordinary paths exactly as given", () => {
		for (const path of [
			"/",
			"/dashboard",
			"/dashboard/settings?tab=security#top",
			"/a/b/c",
			"/search?q=https://example.com",
			"/path%20with%20space",
		]) {
			expect(safeRedirectPath(path)).toBe(path);
		}
	});

	test("trims padding", () => {
		expect(safeRedirectPath("  /dashboard  ")).toBe("/dashboard");
	});

	test("anything that could leave the site becomes the fallback", () => {
		const hostile = [
			"https://evil.example.com",
			"http://evil.example.com/x",
			"//evil.example.com",
			"///evil.example.com",
			"/\\evil.example.com",
			"/%2Fevil.example.com",
			"/%2F%2Fevil.example.com",
			"/%5Cevil.example.com",
			"javascript:alert(1)",
			"data:text/html,<script>1</script>",
			"dashboard",
			"evil.example.com",
			"",
			"   ",
			"/\tevil.example.com",
			"/\n/evil.example.com",
			"/\r\n//evil.example.com",
			"/\u0000x",
			" //evil.example.com",
			"/%E0%A4%A",
			`/${"a".repeat(600)}`,
		];

		for (const value of hostile) {
			expect(`${JSON.stringify(value).slice(0, 40)} -> ${safeRedirectPath(value)}`).toContain(
				"-> /",
			);
			expect(safeRedirectPath(value)).toBe("/");
		}
	});

	test("non-strings become the fallback", () => {
		for (const value of [undefined, null, 5, {}, ["/x"], true]) {
			expect(safeRedirectPath(value)).toBe("/");
		}
	});

	test("the fallback is configurable", () => {
		expect(safeRedirectPath("//evil.example.com", "/home")).toBe("/home");
	});
});

describe("verifyIdToken", () => {
	const KID = "test-key-1";
	const ISSUER = "https://accounts.google.com";
	const CLIENT = "client-123.apps.googleusercontent.com";
	const NONCE = "the-nonce";

	const makeKey = async (kid = KID) => {
		const { publicKey, privateKey } = await generateKeyPair("RS256");
		const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
		return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
	};

	const sign = async (
		privateKey: CryptoKey,
		claims: JWTPayload,
		options: {
			issuer?: string;
			audience?: string | string[];
			expiresIn?: string | number;
			alg?: string;
		} = {},
	) =>
		new SignJWT(claims)
			.setProtectedHeader({ alg: options.alg ?? "RS256", kid: KID })
			.setIssuer(options.issuer ?? ISSUER)
			.setAudience(options.audience ?? CLIENT)
			.setIssuedAt()
			.setExpirationTime(options.expiresIn ?? "5m")
			.sign(privateKey);

	const good: JWTPayload = {
		sub: "1234567890",
		email: "ann@example.com",
		email_verified: true,
		name: "Ann Lee",
		picture: "https://example.com/a.png",
		nonce: NONCE,
	};

	const verify = async (
		token: string,
		jwks: Awaited<ReturnType<typeof makeKey>>["jwks"],
		nonce = NONCE,
	) =>
		verifyIdToken(token, {
			jwks,
			issuers: [ISSUER, "accounts.google.com"],
			audience: CLIENT,
			nonce,
		});

	const rejects = async (
		token: string,
		jwks: Awaited<ReturnType<typeof makeKey>>["jwks"],
		nonce = NONCE,
	) =>
		verify(token, jwks, nonce).then(
			() => "accepted",
			(error: unknown) =>
				error instanceof IdTokenError ? error.message : `unexpected: ${String(error)}`,
		);

	test("returns the claims of a valid token", async () => {
		const { privateKey, jwks } = await makeKey();
		const claims = await verify(await sign(privateKey, good), jwks);

		expect(claims).toEqual({
			sub: "1234567890",
			email: "ann@example.com",
			emailVerified: true,
			name: "Ann Lee",
			picture: "https://example.com/a.png",
		});
	});

	test("accepts both forms of Google's issuer", async () => {
		const { privateKey, jwks } = await makeKey();
		for (const issuer of [ISSUER, "accounts.google.com"]) {
			expect((await verify(await sign(privateKey, good, { issuer }), jwks)).sub).toBe(
				"1234567890",
			);
		}
	});

	test("email_verified is true only for boolean true or the string 'true'", async () => {
		const { privateKey, jwks } = await makeKey();
		const flag = async (value: unknown) =>
			(await verify(await sign(privateKey, { ...good, email_verified: value }), jwks))
				.emailVerified;

		expect(await flag(true)).toBe(true);
		expect(await flag("true")).toBe(true);
		for (const value of [false, "false", "yes", 1, "TRUE", null, undefined]) {
			expect(`${String(value)} -> ${await flag(value)}`).toBe(`${String(value)} -> false`);
		}
	});

	test("missing optional claims become null", async () => {
		const { privateKey, jwks } = await makeKey();
		const claims = await verify(await sign(privateKey, { sub: "42", nonce: NONCE }), jwks);

		expect(claims).toEqual({
			sub: "42",
			email: null,
			emailVerified: false,
			name: null,
			picture: null,
		});
	});

	test("rejects the wrong audience, issuer, expiry and nonce", async () => {
		const { privateKey, jwks } = await makeKey();
		const message = "ID token failed verification";

		expect(await rejects(await sign(privateKey, good, { audience: "another-app" }), jwks)).toBe(
			message,
		);
		expect(
			await rejects(
				await sign(privateKey, good, { issuer: "https://evil.example.com" }),
				jwks,
			),
		).toBe(message);
		expect(await rejects(await sign(privateKey, good, { expiresIn: -10 }), jwks)).toBe(message);
		expect(await rejects(await sign(privateKey, good), jwks, "a-different-nonce")).toBe(
			"ID token nonce mismatch",
		);
		expect(await rejects(await sign(privateKey, { ...good, nonce: undefined }), jwks)).toBe(
			"ID token nonce mismatch",
		);
	});

	test("rejects a token signed by a key the provider does not publish", async () => {
		const trusted = await makeKey();
		const attacker = await makeKey();

		expect(await rejects(await sign(attacker.privateKey, good), trusted.jwks)).toBe(
			"ID token failed verification",
		);
	});

	test("rejects algorithm-confusion attempts: HS256 and 'none'", async () => {
		const { jwks } = await makeKey();
		const hs256 = await new SignJWT(good)
			.setProtectedHeader({ alg: "HS256", kid: KID })
			.setIssuer(ISSUER)
			.setAudience(CLIENT)
			.setExpirationTime("5m")
			.sign(new TextEncoder().encode("any-secret-the-attacker-likes-0123456"));
		const none = `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ ...good, iss: ISSUER, aud: CLIENT, exp: 9_999_999_999 }))}.`;

		expect(await rejects(hs256, jwks)).toBe("ID token failed verification");
		expect(await rejects(none, jwks)).toBe("ID token failed verification");
		expect(await rejects("garbage", jwks)).toBe("ID token failed verification");
	});

	test("rejects a token with no subject", async () => {
		const { privateKey, jwks } = await makeKey();
		expect(await rejects(await sign(privateKey, { ...good, sub: undefined }), jwks)).toBe(
			"ID token has no subject",
		);
	});

	test("several audiences need ourselves as the authorized party", async () => {
		const { privateKey, jwks } = await makeKey();
		const audience = [CLIENT, "another-app"];

		expect(await rejects(await sign(privateKey, good, { audience }), jwks)).toBe(
			"ID token authorized party mismatch",
		);
		expect(
			await rejects(
				await sign(privateKey, { ...good, azp: "another-app" }, { audience }),
				jwks,
			),
		).toBe("ID token authorized party mismatch");
		expect(
			(await verify(await sign(privateKey, { ...good, azp: CLIENT }, { audience }), jwks))
				.sub,
		).toBe("1234567890");
	});
});

describe("postForm", () => {
	const reply =
		(body: string, status = 200) =>
		async () =>
			new Response(body, { status });

	test("sends a form-encoded POST with a timeout and returns the JSON", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const result = await postForm(
			"https://provider.example/token",
			{ code: "abc", redirect_uri: "https://api.example/cb?x=1" },
			{
				fetchImpl: async (url, init) => {
					seen.push({ url, init });
					return new Response('{"id_token":"t"}', { status: 200 });
				},
			},
		);

		expect(result).toEqual({ id_token: "t" });
		expect(seen[0]?.url).toBe("https://provider.example/token");
		expect(seen[0]?.init.method).toBe("POST");
		expect(new Headers(seen[0]?.init.headers).get("content-type")).toBe(
			"application/x-www-form-urlencoded",
		);
		expect(String(seen[0]?.init.body)).toBe(
			"code=abc&redirect_uri=https%3A%2F%2Fapi.example%2Fcb%3Fx%3D1",
		);
		expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
	});

	test("an error status becomes a ProviderHttpError carrying the OAuth error code", async () => {
		const failure = await postForm(
			"https://p.example/t",
			{},
			{
				fetchImpl: reply(
					'{"error":"invalid_grant","error_description":"Bad code abc123"}',
					400,
				),
			},
		).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(ProviderHttpError);
		expect(failure instanceof ProviderHttpError && failure.status).toBe(400);
		expect(failure instanceof ProviderHttpError && failure.oauthError).toBe("invalid_grant");
		// The provider's free text can echo request data; it must not end up in a message.
		expect(failure instanceof Error && failure.message).not.toContain("abc123");
	});

	test("a non-JSON error body still gives a status-only error", async () => {
		const failure = await postForm(
			"https://p.example/t",
			{},
			{ fetchImpl: reply("<html>Bad gateway</html>", 502) },
		).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure instanceof ProviderHttpError && failure.status).toBe(502);
		expect(failure instanceof ProviderHttpError && failure.oauthError).toBeUndefined();
	});

	test("an unreadable success body yields undefined instead of throwing", async () => {
		expect(
			await postForm("https://p.example/t", {}, { fetchImpl: reply("not json") }),
		).toBeUndefined();
	});

	test("network failures propagate to the caller", async () => {
		await expect(
			postForm(
				"https://p.example/t",
				{},
				{
					fetchImpl: async () => {
						throw new Error("connect ECONNREFUSED");
					},
				},
			),
		).rejects.toThrow(/ECONNREFUSED/);
	});
});
