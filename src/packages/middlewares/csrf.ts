import type { Elysia } from "elysia";

import { envAppConfig } from "../env/app.env";
import { AppError } from "../utils/errors";

const CSRF_COOKIE_NAME = "csrf_token";
const CSRF_HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const generateToken = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

// Double-submit cookie CSRF protection. This only matters for browser clients that send
// cookies automatically — a request carrying a Bearer token is never sent by the browser
// on its own initiative, so it isn't vulnerable to CSRF and is skipped here.
//
// - Every response that doesn't already have the cookie gets one issued (readable by JS,
//   NOT httpOnly — the client must be able to read it to echo it back).
// - Every mutating request (anything but GET/HEAD/OPTIONS) must repeat that same value in
//   the `x-csrf-token` header. A request can't set an arbitrary header cross-site without
//   already being able to read the cookie, which a third-party origin can't do.
//
// Must run as `.derive`/`.onBeforeHandle` (not `.onRequest`) — Elysia's parsed `cookie`
// object isn't available that early in the request lifecycle.
export const registerCsrfProtection = (app: Elysia): void => {
	if (!envAppConfig.ENABLE_CSRF_PROTECTION) return;

	app.onBeforeHandle(({ cookie, request }) => {
		const token = cookie[CSRF_COOKIE_NAME];
		if (!token) {
			// Elysia's cookie proxy never actually returns undefined for a valid name (see
			// the Reactive Cookie docs); this satisfies noUncheckedIndexedAccess without a
			// non-null assertion or cast.
			throw AppError.internal("CSRF cookie context unavailable");
		}

		if (!token.value) {
			token.value = generateToken();
			token.httpOnly = false;
			token.path = "/";
			token.sameSite = "lax";
			token.secure = envAppConfig.NODE_ENV === "production";
		}

		if (SAFE_METHODS.has(request.method)) return;
		if (request.headers.has("authorization")) return;

		const headerToken = request.headers.get(CSRF_HEADER_NAME);
		if (!headerToken || headerToken !== token.value) {
			throw AppError.forbidden("Invalid or missing CSRF token");
		}
	});
};
