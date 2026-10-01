import { z } from "zod";

import { parseEnv } from "../utils/parse-env";

// Development-only fallback. Production must provide its own value (see superRefine below).
const DEV_APP_SECRET = "abcdefghijklmnopqrstuvwxyz1234567890";

const serverEnvSchema = z
	.object({
		// Bind host/port for the server process — not the public-facing
		HOST: z.string().default("localhost"),
		PORT: z.coerce.number().default(7164),
		NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
		API_PREFIX: z.string().default("/api"),
		API_VERSION: z.string().default("v1"),

		APP_SECRET: z
			.string()
			.min(10, "APP_SECRET must be at least 10 characters")
			.default(DEV_APP_SECRET),

		RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),
		RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),

		// Rejects request bodies larger than this before they're parsed. 1 MB default.
		BODY_LIMIT_BYTES: z.coerce.number().positive().default(1_000_000),

		LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),

		// z.stringbool understands "true"/"false"/"1"/"0"/"yes"/"no".
		// z.coerce.boolean() would turn the string "false" into true.
		ENABLE_COMPRESSION: z.stringbool().default(true),
		ENABLE_CORS: z.stringbool().default(true),
		ENABLE_RATE_LIMIT: z.stringbool().default(true),
		ENABLE_REQUEST_LOGGING: z.stringbool().default(true),
		ENABLE_SECURITY_HEADERS: z.stringbool().default(true),
		ENABLE_SWAGGER: z.stringbool().default(true),

		ENABLE_CORS_PROTECTION: z.stringbool().default(false),
		ENABLE_CSRF_PROTECTION: z.stringbool().default(false),

		ENABLE_REDIS: z.stringbool().default(false),
		ENABLE_SMTP: z.stringbool().default(false),

		ENABLE_EMAIL_AUTH: z.stringbool().default(false),
		ENABLE_PHONE_AUTH: z.stringbool().default(false),
	})
	.superRefine((env, ctx) => {
		if (env.NODE_ENV !== "production") return;

		if (env.APP_SECRET === DEV_APP_SECRET || env.APP_SECRET.length < 32) {
			ctx.addIssue({
				code: "custom",
				path: ["APP_SECRET"],
				message:
					"APP_SECRET must be a unique value of at least 32 characters in production",
			});
		}
	});

export const envAppConfig = Object.freeze({
	...parseEnv(serverEnvSchema, "App"),
});

export type EnvAppConfig = typeof envAppConfig;
