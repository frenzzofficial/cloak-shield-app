import { createHmac, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

import { envAuthConfig } from "@/packages/env/auth.env";

// The state that must survive the round trip to the provider and back: which flow this is, the
// anti-CSRF `state`, the OIDC `nonce`, the PKCE verifier, and where to send the user afterwards.
// It travels in a short-lived httpOnly cookie, SIGNED so it cannot be forged or edited. Keeping it
// in a cookie (not a database row) means it works on serverless hosts with no shared memory.
//
// The verifier is in the payload of a signed (not encrypted) token, which is fine for PKCE: it
// sits in an httpOnly cookie the page cannot read, and it only matters together with the
// authorization code, which the attacker would also have to steal.

export interface OAuthStatePayload {
	provider: string;
	state: string;
	nonce: string;
	verifier: string;
	/** An already-sanitized relative path on the frontend. */
	redirect: string;
}

const ISSUER = "cloak-shield:oauth-state";
const AUDIENCE = "oauth-state";
export const STATE_TTL_SECONDS = 600;

// A key derived for this one purpose, so a state token can never be confused with an access token
// even though both come from the same configured secret.
const key = createHmac("sha256", envAuthConfig.AUTH_ACCESS_TOKEN_SECRET)
	.update("cloak-shield:oauth-state:v1")
	.digest();

export const sealOAuthState = async (
	payload: OAuthStatePayload,
	ttlSeconds: number = STATE_TTL_SECONDS,
): Promise<string> =>
	new SignJWT({ ...payload })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuer(ISSUER)
		.setAudience(AUDIENCE)
		.setIssuedAt()
		.setExpirationTime(Math.floor(Date.now() / 1_000) + ttlSeconds)
		.sign(key);

const text = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

/** Returns the payload, or null for anything wrong: tampered, expired, malformed, wrong key. */
export const unsealOAuthState = async (token: string): Promise<OAuthStatePayload | null> => {
	try {
		const { payload } = await jwtVerify(token, key, {
			algorithms: ["HS256"],
			issuer: ISSUER,
			audience: AUDIENCE,
		});

		const provider = text(payload.provider);
		const state = text(payload.state);
		const nonce = text(payload.nonce);
		const verifier = text(payload.verifier);
		const redirect = text(payload.redirect);

		if (!provider || !state || !nonce || !verifier || redirect === undefined) return null;
		return { provider, state, nonce, verifier, redirect };
	} catch {
		return null;
	}
};

/** Constant-time string comparison, for state and nonce checks. */
export const safeEqual = (a: string, b: string): boolean => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};
