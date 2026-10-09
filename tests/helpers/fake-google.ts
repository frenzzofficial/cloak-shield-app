import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	type JWK,
	type JWTPayload,
	type JWTVerifyGetKey,
	SignJWT,
} from "jose";

import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL } from "../../src/app/auth/google/google.client";
import type { FetchLike } from "../../src/packages/oauth/http";
import { codeChallengeS256 } from "../../src/packages/oauth/pkce";

// A stand-in for Google that behaves like the real one where it matters for security:
//   - it REFUSES a malformed authorization request (so our /start is tested against Google's rules)
//   - codes are single-use and bound to the PKCE challenge they were issued against
//   - ID tokens are genuinely RSA-signed and published through a JWKS, so signature checking is real
// Everything it receives from our server is recorded, so tests can also assert what was NOT sent.

export interface GoogleAccount {
	sub: string;
	email: string | undefined;
	emailVerified: boolean | string | undefined;
	name?: string;
	picture?: string;
}

export interface TokenOverrides {
	audience?: string | string[];
	issuer?: string;
	expiresIn?: number | string;
	/** null = leave the nonce out entirely. */
	nonce?: string | null;
	alg?: "RS256" | "HS256";
	signWith?: "attacker";
	claims?: JWTPayload;
}

interface IssuedCode {
	challenge: string;
	nonce: string;
	account: GoogleAccount;
	used: boolean;
}

export type TokenEndpointMode = "ok" | "http500" | "network" | "garbage" | "no_id_token";

const KID = "fake-google-key-1";

export class FakeGoogle {
	readonly clientId = "test-client-123.apps.googleusercontent.com";
	readonly clientSecret = "test-client-secret-do-not-leak";
	readonly redirectUri = "https://api.example.test/api/v1/auth/google/callback";

	readonly jwks: JWTVerifyGetKey;
	/** Everything our server sent to the token endpoint. */
	readonly tokenCalls: Record<string, string>[] = [];

	/** Applied to the NEXT ID token only. */
	override: TokenOverrides | undefined;
	tokenEndpoint: TokenEndpointMode = "ok";

	private readonly issued = new Map<string, IssuedCode>();

	private constructor(
		private readonly privateKey: CryptoKey,
		private readonly attackerKey: CryptoKey,
		jwks: JWTVerifyGetKey,
	) {
		this.jwks = jwks;
	}

	static async create(): Promise<FakeGoogle> {
		const real = await generateKeyPair("RS256");
		const attacker = await generateKeyPair("RS256");
		const jwk: JWK = {
			...(await exportJWK(real.publicKey)),
			kid: KID,
			alg: "RS256",
			use: "sig",
		};

		return new FakeGoogle(
			real.privateKey,
			attacker.privateKey,
			createLocalJWKSet({ keys: [jwk] }),
		);
	}

	/**
	 * The browser at accounts.google.com: checks the authorization request our server built, lets
	 * the user "sign in" as `account`, and returns the callback path + query Google would redirect to.
	 */
	authorize(
		location: string,
		account: GoogleAccount,
		options: { error?: string; omitState?: boolean } = {},
	): { path: string; code: string; state: string } {
		const url = new URL(location);
		const param = (name: string): string => {
			const value = url.searchParams.get(name);
			if (!value) throw new Error(`Google would reject this request: missing ${name}`);
			return value;
		};

		if (`${url.origin}${url.pathname}` !== GOOGLE_AUTH_URL)
			throw new Error(`not Google's authorize URL: ${url.origin}${url.pathname}`);
		if (param("client_id") !== this.clientId)
			throw new Error("Google would reject this request: wrong client_id");
		if (param("redirect_uri") !== this.redirectUri)
			throw new Error(
				`Google would reject this request: redirect_uri ${param("redirect_uri")} is not registered`,
			);
		if (param("response_type") !== "code")
			throw new Error("Google would reject this request: response_type");
		if (param("code_challenge_method") !== "S256")
			throw new Error("Google would reject this request: PKCE must be S256");
		if (param("code_challenge").length !== 43)
			throw new Error("Google would reject this request: code_challenge length");
		if (!param("scope").split(" ").includes("openid"))
			throw new Error("Google would reject this request: scope lacks openid");
		if (url.searchParams.has("client_secret"))
			throw new Error("the client secret must NEVER be sent through the browser");

		const state = param("state");
		const nonce = param("nonce");
		const callback = new URL(this.redirectUri);

		if (options.error) {
			callback.searchParams.set("error", options.error);
			if (!options.omitState) callback.searchParams.set("state", state);
			return { path: `${callback.pathname}${callback.search}`, code: "", state };
		}

		const code = `code-${crypto.randomUUID()}`;
		this.issued.set(code, { challenge: param("code_challenge"), nonce, account, used: false });

		callback.searchParams.set("code", code);
		if (!options.omitState) callback.searchParams.set("state", state);
		return { path: `${callback.pathname}${callback.search}`, code, state };
	}

	/** Our server's HTTP client points here instead of the network. */
	readonly fetch: FetchLike = async (url, init) => {
		if (url !== GOOGLE_TOKEN_URL) return new Response("not found", { status: 404 });

		const form = Object.fromEntries(new URLSearchParams(String(init.body)));
		this.tokenCalls.push(form);

		if (this.tokenEndpoint === "network") throw new Error("connect ECONNREFUSED");
		if (this.tokenEndpoint === "http500") return new Response("{}", { status: 500 });
		if (this.tokenEndpoint === "garbage")
			return new Response("<html>oops</html>", { status: 200 });

		const grant = (error: string) => new Response(JSON.stringify({ error }), { status: 400 });

		if (form.grant_type !== "authorization_code") return grant("unsupported_grant_type");
		if (form.client_id !== this.clientId || form.client_secret !== this.clientSecret)
			return grant("invalid_client");
		if (form.redirect_uri !== this.redirectUri) return grant("redirect_uri_mismatch");

		const entry = this.issued.get(form.code ?? "");
		if (!entry || entry.used) return grant("invalid_grant");
		// Single use: a replayed code dies here even if everything else is right.
		entry.used = true;
		if (!form.code_verifier || codeChallengeS256(form.code_verifier) !== entry.challenge) {
			return grant("invalid_grant");
		}

		if (this.tokenEndpoint === "no_id_token") {
			return Response.json({ access_token: "fake-access-token", token_type: "Bearer" });
		}

		return Response.json({
			access_token: "fake-access-token",
			token_type: "Bearer",
			expires_in: 3600,
			id_token: await this.mintIdToken(entry),
		});
	};

	private async mintIdToken(entry: IssuedCode): Promise<string> {
		const overrides = this.override ?? {};
		this.override = undefined;

		const nonce = overrides.nonce === undefined ? entry.nonce : overrides.nonce;
		const claims: JWTPayload = {
			sub: entry.account.sub,
			email: entry.account.email,
			email_verified: entry.account.emailVerified,
			name: entry.account.name,
			picture: entry.account.picture,
			...(nonce === null ? {} : { nonce }),
			...overrides.claims,
		};

		const header = { alg: overrides.alg ?? "RS256", kid: KID };
		const builder = new SignJWT(claims)
			.setProtectedHeader(header)
			.setIssuer(overrides.issuer ?? "https://accounts.google.com")
			.setAudience(overrides.audience ?? this.clientId)
			.setIssuedAt()
			.setExpirationTime(overrides.expiresIn ?? "5m");

		if (overrides.alg === "HS256") {
			return builder.sign(
				new TextEncoder().encode("a-secret-the-attacker-picked-0123456789"),
			);
		}
		return builder.sign(overrides.signWith === "attacker" ? this.attackerKey : this.privateKey);
	}
}
