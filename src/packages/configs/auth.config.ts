import { envAuthConfig } from "../env/auth.env";

// Auth behavior in one place. Values come from validated env (see env/auth.env.ts).
// The object is intentionally NOT frozen: tests flip `requireEmailVerification` to cover
// both modes without re-importing the env module. Application code only reads it.
export const authConfig = {
	accessTokenTtlSeconds: envAuthConfig.AUTH_ACCESS_TOKEN_TTL,
	longSessionTtlSeconds: envAuthConfig.AUTH_REFRESH_TOKEN_TTL,
	shortSessionTtlSeconds: envAuthConfig.AUTH_SHORT_SESSION_TTL,
	refreshReuseGraceMs: envAuthConfig.AUTH_REFRESH_REUSE_GRACE * 1_000,

	maxFailedLogins: envAuthConfig.AUTH_MAX_FAILED_LOGINS,
	lockoutSeconds: envAuthConfig.AUTH_LOCKOUT_DURATION,
	maxSessionsPerUser: envAuthConfig.AUTH_MAX_SESSIONS_PER_USER,

	cookieSameSite: envAuthConfig.AUTH_COOKIE_SAMESITE,
	cookieDomain: envAuthConfig.AUTH_COOKIE_DOMAIN,

	requireEmailVerification: envAuthConfig.AUTH_REQUIRE_EMAIL_VERIFICATION,
	reauthWindowSeconds: envAuthConfig.AUTH_REAUTH_WINDOW,
	newDeviceWindowSeconds: envAuthConfig.AUTH_NEW_DEVICE_WINDOW,
	verifyTokenTtlSeconds: envAuthConfig.AUTH_VERIFY_TOKEN_TTL,
	resetTokenTtlSeconds: envAuthConfig.AUTH_RESET_TOKEN_TTL,

	isProduction: envAuthConfig.NODE_ENV === "production",
};
