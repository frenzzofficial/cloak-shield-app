import { z } from "zod";

import { parseEnv } from "../utils/parse-env";
import { durationSeconds } from "./duration";

// Development-only fallbacks so `bun run dev` works with an empty .env.
// Production must provide its own, distinct, 32+ character secrets (see superRefine).
const DEV_ACCESS_SECRET = "dev-only-access-secret-change-me-0123456789";
const DEV_REFRESH_SECRET = "dev-only-refresh-secret-change-me-012345678";

const MIN_SECRET_LENGTH = 32;

const authEnvSchema = z
	.object({
		NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

		AUTH_ACCESS_TOKEN_SECRET: z.string().min(16).default(DEV_ACCESS_SECRET),
		AUTH_REFRESH_TOKEN_SECRET: z.string().min(16).default(DEV_REFRESH_SECRET),

		// Lifetimes. Accept 30s / 15m / 12h / 30d.
		AUTH_ACCESS_TOKEN_TTL: durationSeconds("AUTH_ACCESS_TOKEN_TTL").prefault("15m"),
		// Session length when "remember me" is ticked.
		AUTH_REFRESH_TOKEN_TTL: durationSeconds("AUTH_REFRESH_TOKEN_TTL").prefault("30d"),
		// Session length when "remember me" is NOT ticked.
		AUTH_SHORT_SESSION_TTL: durationSeconds("AUTH_SHORT_SESSION_TTL").prefault("1d"),
		// A refresh token that was rotated less than this long ago is treated as a harmless
		// race (two tabs refreshing at once). Older replays revoke the whole session.
		AUTH_REFRESH_REUSE_GRACE: durationSeconds("AUTH_REFRESH_REUSE_GRACE").prefault("10s"),

		AUTH_MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
		AUTH_LOCKOUT_DURATION: durationSeconds("AUTH_LOCKOUT_DURATION").prefault("15m"),
		AUTH_MAX_SESSIONS_PER_USER: z.coerce.number().int().positive().default(10),

		// Cookies. SameSite=none is required when the frontend lives on a different SITE
		// (not just a different subdomain) and forces the Secure flag.
		AUTH_COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
		AUTH_COOKIE_DOMAIN: z.string().trim().min(1).optional(),

		// When true, sign-up creates the account but issues no session until the email is
		// verified, and sign-in refuses PENDING_VERIFICATION accounts.
		AUTH_REQUIRE_EMAIL_VERIFICATION: z.stringbool().default(false),
		// Accounts without a password (Google/Discord only) re-authenticate sensitive actions by a
		// sign-in no older than this, instead of typing a password.
		AUTH_REAUTH_WINDOW: durationSeconds("AUTH_REAUTH_WINDOW").prefault("10m"),
		// "New device" alerts: a browser/OS combination not seen signing in within this window.
		AUTH_NEW_DEVICE_WINDOW: durationSeconds("AUTH_NEW_DEVICE_WINDOW").prefault("90d"),
		AUTH_VERIFY_TOKEN_TTL: durationSeconds("AUTH_VERIFY_TOKEN_TTL").prefault("24h"),
		AUTH_RESET_TOKEN_TTL: durationSeconds("AUTH_RESET_TOKEN_TTL").prefault("1h"),
	})
	.superRefine((env, ctx) => {
		if (env.NODE_ENV !== "production") return;

		const check = (
			key: "AUTH_ACCESS_TOKEN_SECRET" | "AUTH_REFRESH_TOKEN_SECRET",
			dev: string,
		) => {
			const value = env[key];
			if (value === dev || value.length < MIN_SECRET_LENGTH) {
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: `${key} must be a unique value of at least ${MIN_SECRET_LENGTH} characters in production`,
				});
			}
		};

		check("AUTH_ACCESS_TOKEN_SECRET", DEV_ACCESS_SECRET);
		check("AUTH_REFRESH_TOKEN_SECRET", DEV_REFRESH_SECRET);

		if (env.AUTH_ACCESS_TOKEN_SECRET === env.AUTH_REFRESH_TOKEN_SECRET) {
			ctx.addIssue({
				code: "custom",
				path: ["AUTH_REFRESH_TOKEN_SECRET"],
				message: "AUTH_REFRESH_TOKEN_SECRET must differ from AUTH_ACCESS_TOKEN_SECRET",
			});
		}
	});

export const parseAuthEnv = (source: Record<string, string | undefined> = process.env) =>
	parseEnv(authEnvSchema, "Auth", source);

export const envAuthConfig = Object.freeze(parseAuthEnv());

export type EnvAuthConfig = typeof envAuthConfig;
