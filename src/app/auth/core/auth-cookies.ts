import type { Context } from "elysia";

import { appConfig } from "../../../packages/configs/app.config";
import { authConfig } from "../../../packages/configs/auth.config";
import { ACCESS_COOKIE } from "../../../packages/middlewares/authenticate";

const REFRESH_COOKIE = "refresh_token";

type CookieJar = Context["cookie"];

// The access cookie goes to every route (it authenticates the whole API). The refresh cookie is
// scoped to the auth routes only, so it is not attached to ordinary API traffic.
const ACCESS_PATH = "/";
const REFRESH_PATH = appConfig.auth.authEmail.path;

const baseOptions = () => ({
	httpOnly: true,
	// Browsers reject SameSite=None cookies that are not Secure, so force it on.
	secure: authConfig.isProduction || authConfig.cookieSameSite === "none",
	sameSite: authConfig.cookieSameSite,
	...(authConfig.cookieDomain ? { domain: authConfig.cookieDomain } : {}),
});

export const setAuthCookies = (
	cookie: CookieJar,
	tokens: { accessToken: string; refreshToken: string },
	sessionExpiresAt: Date,
): void => {
	cookie[ACCESS_COOKIE]?.set({
		...baseOptions(),
		value: tokens.accessToken,
		path: ACCESS_PATH,
		maxAge: authConfig.accessTokenTtlSeconds,
	});

	// The refresh cookie lives exactly as long as the session, so a "don't remember me" login
	// (1 day) is not silently turned into a 30-day cookie.
	cookie[REFRESH_COOKIE]?.set({
		...baseOptions(),
		value: tokens.refreshToken,
		path: REFRESH_PATH,
		maxAge: Math.max(0, Math.floor((sessionExpiresAt.getTime() - Date.now()) / 1_000)),
	});
};

// A cookie is only removed when the clearing Set-Cookie carries the same name, path and domain.
export const clearAuthCookies = (cookie: CookieJar): void => {
	cookie[ACCESS_COOKIE]?.set({ ...baseOptions(), value: "", path: ACCESS_PATH, maxAge: 0 });
	cookie[REFRESH_COOKIE]?.set({ ...baseOptions(), value: "", path: REFRESH_PATH, maxAge: 0 });
};

const stringOrUndefined = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Browsers send the refresh token as a cookie. Non-browser clients (mobile, server-to-server)
 * may send `{ "refreshToken": "..." }` in the JSON body instead.
 */
export const readRefreshToken = (cookie: CookieJar, body: unknown): string | undefined => {
	const fromCookie = stringOrUndefined(cookie[REFRESH_COOKIE]?.value);
	if (fromCookie) return fromCookie;

	if (typeof body === "object" && body !== null && "refreshToken" in body) {
		return stringOrUndefined(body.refreshToken);
	}
	return undefined;
};

/**
 * Token-in-body mode: only when a client opts in with `x-auth-mode: token`. Browsers never
 * get tokens in the response body (that would defeat the httpOnly cookies).
 */
export const wantsTokensInBody = (request: Request): boolean =>
	request.headers.get("x-auth-mode") === "token";
