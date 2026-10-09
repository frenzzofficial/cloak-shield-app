import type { Context } from "elysia";

import { authConfig } from "@/packages/configs/auth.config";
import { envClientConfig } from "@/packages/env/client.env";
import { envOAuthConfig } from "@/packages/env/oauth.env";
import { STATE_TTL_SECONDS } from "@/packages/oauth/state";
import type { RefusalReason } from "./identity.service";

// What every provider plugin (Google now, Discord later) needs around the redirect dance, so each
// one only writes what is actually specific to it. The browser contract with the frontend lives
// here too: one callback URL shape, one fixed vocabulary of error codes.

type CookieJar = Context["cookie"];

/**
 * The fixed set of failures a frontend can be told about. Deliberately coarse: a provider's own
 * error text can echo request data and tells an attacker nothing they should know, so it stays in
 * the server log.
 */
export type OAuthErrorCode =
	| "access_denied" // the user pressed Cancel at the provider
	| "provider_error" // the provider reported some other error
	| "state_invalid" // missing, expired, tampered or mismatched state: not a flow we started
	| "exchange_failed" // the provider refused the authorization code, or could not be reached
	| "token_invalid" // the ID token failed verification
	| RefusalReason // email_missing | email_unverified | account_blocked | provider_conflict
	| "server_error";

export type OAuthCallbackResult =
	| { status: "success"; redirect: string }
	| { status: "error"; error: OAuthErrorCode };

/** Where the browser is sent when a sign-in attempt ends, successfully or not. */
export const callbackUrl = (result: OAuthCallbackResult): string => {
	const url = new URL(envOAuthConfig.OAUTH_CALLBACK_PATH, envClientConfig.CLIENT_ORIGIN);
	url.searchParams.set("status", result.status);

	if (result.status === "success") url.searchParams.set("redirect", result.redirect);
	else url.searchParams.set("error", result.error);

	return url.toString();
};

// ── The signed state cookie ────────────────────────────────────────────────────

export const oauthStateCookieName = (provider: string): string => `oauth_state_${provider}`;

// SameSite=Lax whatever AUTH_COOKIE_SAMESITE says. The provider sends the browser back with a
// top-level navigation from another site; "strict" would drop the cookie on exactly that request
// and every sign-in would fail with state_invalid. Lax still keeps it off cross-site sub-requests.
const stateCookieOptions = (path: string) => ({
	httpOnly: true,
	secure: authConfig.isProduction,
	sameSite: "lax" as const,
	path,
});

export const setOAuthStateCookie = (
	cookie: CookieJar,
	provider: string,
	path: string,
	sealed: string,
): void => {
	cookie[oauthStateCookieName(provider)]?.set({
		...stateCookieOptions(path),
		value: sealed,
		maxAge: STATE_TTL_SECONDS,
	});
};

/**
 * Reads the state cookie AND clears it, in one step. It is single-use by design: whatever happens
 * next (success, failure, an attacker replaying the callback), this state can never be used again.
 */
export const takeOAuthStateCookie = (
	cookie: CookieJar,
	provider: string,
	path: string,
): string | undefined => {
	const entry = cookie[oauthStateCookieName(provider)];
	const value =
		typeof entry?.value === "string" && entry.value.length > 0 ? entry.value : undefined;

	entry?.set({ ...stateCookieOptions(path), value: "", maxAge: 0 });
	return value;
};
