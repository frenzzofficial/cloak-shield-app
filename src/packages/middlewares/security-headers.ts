import type { Elysia } from "elysia";

import { envAppConfig } from "../env/app.env";

// Sets standard security response headers (CSP, X-Frame-Options, HSTS, Referrer-Policy,
// Permissions-Policy, ...). This is a JSON API, not an HTML app, so the CSP is locked
// down to "nothing is allowed to load" rather than an HTML-app's usual defaults — with
// ONE deliberate exception: the Swagger UI docs page (/openapi) loads its JS/CSS bundle
// from unpkg.com (see openapi.ts), so it gets a relaxed CSP that allows that one CDN.
// Every other route keeps the fully locked-down policy.
//
// Hand-written — no dependency. The `elysiajs-helmet` package worked perfectly under
// `bun run` locally (Bun executes TypeScript directly), but its package.json points
// `main`/`exports` straight at raw `src/index.ts` instead of a compiled `dist/*.js` (every
// other dependency here, including the two official @elysiajs/* packages, ships compiled
// JS). Vercel's serverless bundler couldn't trace that raw-TypeScript entry point, so the
// package was silently excluded from the deployed function — "Cannot find package
// 'elysiajs-helmet'" at runtime, even though `bun install` and a local `bun build` both
// succeed. A plain header-setting hook removes that risk entirely.
//
// Register this early — before routes and before the rate limiter/CSRF checks — so every
// response gets these headers, including error responses.
const HSTS_MAX_AGE_SECONDS = 15_552_000; // 180 days
const SWAGGER_UI_CDN = "https://unpkg.com";

const buildCsp = (isSwaggerUiPage: boolean): string =>
	[
		"default-src 'none'",
		isSwaggerUiPage
			? `script-src 'self' 'unsafe-inline' ${SWAGGER_UI_CDN}`
			: "script-src 'self' 'unsafe-inline'",
		isSwaggerUiPage
			? `style-src 'self' 'unsafe-inline' ${SWAGGER_UI_CDN}`
			: "style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self'",
		isSwaggerUiPage ? `connect-src 'self' ${SWAGGER_UI_CDN}` : "connect-src 'self'",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
	].join("; ");

const buildPermissionsPolicy = (): string =>
	["camera=()", "microphone=()", "geolocation=()", "interest-cohort=()"].join(", ");

export const registerSecurityHeaders = (app: Elysia): void => {
	if (!envAppConfig.ENABLE_SECURITY_HEADERS) return;

	app.onRequest(({ set, request }) => {
		const { pathname } = new URL(request.url);
		const isSwaggerUiPage = pathname === "/openapi";

		set.headers["x-frame-options"] = "DENY";
		set.headers["x-xss-protection"] = "1; mode=block";
		set.headers["x-content-type-options"] = "nosniff";
		set.headers["referrer-policy"] = "no-referrer";
		set.headers["x-dns-prefetch-control"] = "off";
		set.headers["cross-origin-resource-policy"] = "same-origin";
		set.headers["cross-origin-opener-policy"] = "same-origin";
		set.headers["content-security-policy"] = buildCsp(isSwaggerUiPage);
		set.headers["permissions-policy"] = buildPermissionsPolicy();

		if (envAppConfig.NODE_ENV === "production") {
			set.headers["strict-transport-security"] =
				`max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`;
		}
	});
};
