import { createHash, randomBytes } from "node:crypto";

// PKCE (RFC 7636). The verifier never leaves our server until the code exchange, so a stolen
// authorization code is useless on its own.

/** 43 URL-safe characters: the minimum length RFC 7636 allows, from 256 bits of randomness. */
export const generateCodeVerifier = (): string => randomBytes(32).toString("base64url");

export const codeChallengeS256 = (verifier: string): string =>
	createHash("sha256").update(verifier).digest("base64url");

/** Unguessable value for `state` and `nonce`. */
export const generateRandomToken = (): string => randomBytes(32).toString("base64url");
