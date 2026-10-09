import type { JWTVerifyGetKey } from "jose";

import type { DeviceInfo, SessionTokens } from "@/app/auth/core/auth.types";
import { notifyProviderLinked } from "@/app/auth/core/auth-mail";
import { IdentityRefusal } from "@/app/auth/core/identity.service";
import type { OAuthErrorCode } from "@/app/auth/core/oauth-flow";
import type { AuthCore } from "@/app/auth/core/plugin";
import { AuditEvents } from "@/packages/configs/audit.config";
import type { FetchLike } from "@/packages/oauth/http";
import { IdTokenError, verifyIdToken } from "@/packages/oauth/oidc";
import {
	codeChallengeS256,
	generateCodeVerifier,
	generateRandomToken,
} from "@/packages/oauth/pkce";
import { safeRedirectPath } from "@/packages/oauth/redirect";
import { safeEqual, sealOAuthState, unsealOAuthState } from "@/packages/oauth/state";
import { logger } from "@/packages/utils/logger";
import { buildAuthorizationUrl, exchangeAuthorizationCode, GOOGLE_ISSUERS } from "./google.client";

export const GOOGLE_PROVIDER_KEY = "google";

export interface GoogleDeps {
	clientId: string;
	clientSecret: string;
	/** Exactly what is registered in the Google console. */
	redirectUri: string;
	jwks: JWTVerifyGetKey;
	fetchImpl?: FetchLike | undefined;
}

// ── Step 1: send the user to Google ────────────────────────────────────────────

export const startGoogleLogin = async (
	deps: GoogleDeps,
	redirectInput: unknown,
): Promise<{ location: string; sealedState: string }> => {
	const state = generateRandomToken();
	const nonce = generateRandomToken();
	const verifier = generateCodeVerifier();

	const sealedState = await sealOAuthState({
		provider: GOOGLE_PROVIDER_KEY,
		state,
		nonce,
		verifier,
		// Sanitized HERE, when it enters the system, so nothing downstream ever holds a hostile value.
		redirect: safeRedirectPath(redirectInput),
	});

	const location = buildAuthorizationUrl({
		clientId: deps.clientId,
		redirectUri: deps.redirectUri,
		state,
		nonce,
		codeChallenge: codeChallengeS256(verifier),
	});

	return { location, sealedState };
};

// ── Step 2: Google sends the user back ─────────────────────────────────────────

export interface CallbackQuery {
	code: string | undefined;
	state: string | undefined;
	error: string | undefined;
}

export type CompleteResult =
	| { kind: "success"; login: SessionTokens; redirect: string }
	| { kind: "error"; error: OAuthErrorCode };

const failure = (error: OAuthErrorCode): CompleteResult => ({ kind: "error", error });

/**
 * Verifies everything about a returning user in the order that cheaply rejects the most: is this a
 * flow WE started (signed state), did Google say yes, will Google swap the code for a token (PKCE),
 * is the token genuinely Google's and for this login (signature, audience, nonce), and finally which
 * account it is (core identity rules). Only then is a session opened.
 */
export const completeGoogleLogin = async (args: {
	deps: GoogleDeps;
	core: AuthCore;
	query: CallbackQuery;
	sealedState: string | undefined;
	device: DeviceInfo;
}): Promise<CompleteResult> => {
	const { deps, core, query, sealedState, device } = args;

	// 1. Our own state: signed, unexpired, for this provider, and matching what came back in the URL.
	const saved = sealedState ? await unsealOAuthState(sealedState) : null;
	if (
		!saved ||
		saved.provider !== GOOGLE_PROVIDER_KEY ||
		!query.state ||
		!safeEqual(saved.state, query.state)
	) {
		return failure("state_invalid");
	}

	// 2. Google reported a problem (most often: the user pressed Cancel).
	if (query.error)
		return failure(query.error === "access_denied" ? "access_denied" : "provider_error");
	if (!query.code) return failure("provider_error");

	// 3. Redeem the code. Google checks the PKCE verifier, so a code stolen from the URL is useless.
	let idToken: string;
	try {
		idToken = await exchangeAuthorizationCode({
			clientId: deps.clientId,
			clientSecret: deps.clientSecret,
			redirectUri: deps.redirectUri,
			code: query.code,
			verifier: saved.verifier,
			fetchImpl: deps.fetchImpl,
		});
	} catch (error) {
		logger.warn("google code exchange failed", {
			reason: error instanceof Error ? error.message : "unknown",
		});
		return failure("exchange_failed");
	}

	// 4. The token must really be Google's, for this app, for THIS login.
	let claims: Awaited<ReturnType<typeof verifyIdToken>>;
	try {
		claims = await verifyIdToken(idToken, {
			jwks: deps.jwks,
			issuers: GOOGLE_ISSUERS,
			audience: deps.clientId,
			nonce: saved.nonce,
		});
	} catch (error) {
		if (!(error instanceof IdTokenError)) logger.error("google token check crashed");
		return failure("token_invalid");
	}

	// 5. Which account is this? One set of rules for every provider, in core.
	let resolved: Awaited<ReturnType<AuthCore["identities"]["resolve"]>>;
	try {
		resolved = await core.identities.resolve(
			{
				provider: "GOOGLE",
				providerUserId: claims.sub,
				email: claims.email,
				emailVerified: claims.emailVerified,
				fullname: claims.name,
				avatarUrl: claims.picture,
			},
			device,
		);
	} catch (error) {
		if (error instanceof IdentityRefusal) return failure(error.reason);
		throw error;
	}

	// 6. Open the session: tokens, audit row, session cap, new-device alert, all from core.
	const login = await core.sessions.start(resolved.user, device, {
		// There is no "remember me" box on someone else's login page, so use the long session.
		remember: true,
		metadata: { provider: "GOOGLE", outcome: resolved.outcome },
	});

	// A Google account just got attached to an existing account: tell its owner.
	if (resolved.outcome === "linked" || resolved.outcome === "reclaimed") {
		await notifyProviderLinked(resolved.user, "GOOGLE", device);
	}

	return { kind: "success", login, redirect: safeRedirectPath(saved.redirect) };
};

/** Failed attempts go in the audit trail with a reason, never with anything the user typed. */
export const recordGoogleFailure = (core: AuthCore, device: DeviceInfo, error: OAuthErrorCode) =>
	core.audit.record({
		event: AuditEvents.SIGN_IN_FAILURE,
		outcome: "FAILURE",
		device,
		metadata: { provider: "GOOGLE", reason: error },
	});
