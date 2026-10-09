import { type JWTVerifyGetKey, jwtVerify } from "jose";

import { logger } from "../utils/logger";
import { safeEqual } from "./state";

// Verifying an OpenID Connect ID token. The checks that matter, and what each one stops:
//   signature (RS256 only)  forged tokens, and the "alg: none" / HS256-with-the-public-key tricks
//   issuer                  a token from some other identity provider
//   audience                a token minted for ANOTHER app that this one would otherwise accept
//   expiry                  replaying an old token
//   nonce                   replaying a token from a different login attempt (it is tied to ours)
//   azp                     multi-audience tokens issued to a different authorized party

export interface IdTokenClaims {
	/** The provider's stable user id. */
	sub: string;
	email: string | null;
	emailVerified: boolean;
	name: string | null;
	picture: string | null;
}

export class IdTokenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IdTokenError";
	}
}

export interface VerifyIdTokenOptions {
	/** Key lookup: a remote JWKS in production, a local one in tests. */
	jwks: JWTVerifyGetKey;
	issuers: readonly string[];
	/** Our OAuth client id. */
	audience: string;
	/** The nonce we sent in the authorization request. */
	nonce: string;
}

const text = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

export const verifyIdToken = async (
	idToken: string,
	options: VerifyIdTokenOptions,
): Promise<IdTokenClaims> => {
	let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];

	try {
		({ payload } = await jwtVerify(idToken, options.jwks, {
			algorithms: ["RS256"],
			issuer: [...options.issuers],
			audience: options.audience,
		}));
	} catch (error) {
		// The reason (bad signature, wrong audience, expired, key fetch failed, ...) is deliberately
		// not surfaced to the caller: it helps whoever reads the log, never whoever sent the token.
		logger.warn("ID token rejected", {
			reason: error instanceof Error ? (Reflect.get(error, "code") ?? error.name) : "unknown",
		});
		throw new IdTokenError("ID token failed verification");
	}

	const nonce = text(payload.nonce);
	if (!nonce || !safeEqual(nonce, options.nonce))
		throw new IdTokenError("ID token nonce mismatch");

	// Several audiences: the token must have been issued to US as the authorized party.
	if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== options.audience) {
		throw new IdTokenError("ID token authorized party mismatch");
	}

	const sub = text(payload.sub);
	if (!sub) throw new IdTokenError("ID token has no subject");

	return {
		sub,
		email: text(payload.email),
		// Google has been seen sending this as the string "true"; anything else is NOT verified.
		emailVerified: payload.email_verified === true || payload.email_verified === "true",
		name: text(payload.name),
		picture: text(payload.picture),
	};
};
