import { z } from "zod";

import { parseEnv } from "../utils/parse-env";

// Settings for "Sign in with <provider>". Everything here is optional until a provider is switched
// on: a deployment that does not use Google needs none of it.

const isLocal = (host: string): boolean =>
	host === "localhost" || host === "127.0.0.1" || host === "[::1]";

const oauthEnvSchema = z
	.object({
		NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

		// The PUBLIC address of THIS API, as the provider's servers and the user's browser reach it.
		// Google redirects the browser back to `${API_PUBLIC_URL}/api/v1/auth/google/callback`, and
		// that exact string must be registered in the provider's console. No trailing slash.
		API_PUBLIC_URL: z
			.url()
			.trim()
			.transform((value) => value.replace(/\/+$/, ""))
			.optional(),

		// Where on the FRONTEND (CLIENT_ORIGIN) the browser lands after a sign-in attempt. It gets
		// ?status=success&redirect=<path> or ?status=error&error=<code>.
		OAUTH_CALLBACK_PATH: z
			.string()
			.trim()
			.default("/auth/callback")
			.refine((value) => value.startsWith("/") && !value.startsWith("//"), {
				message: "OAUTH_CALLBACK_PATH must be a path starting with a single /",
			}),

		ENABLE_GOOGLE_AUTH: z.stringbool().default(false),
		GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
		GOOGLE_CLIENT_SECRET: z.string().trim().min(1).optional(),
	})
	.superRefine((env, ctx) => {
		const need = (key: keyof typeof env, label: string) => {
			if (env[key] === undefined) {
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: `${label} is required when ENABLE_GOOGLE_AUTH=true`,
				});
			}
		};

		if (env.ENABLE_GOOGLE_AUTH) {
			need("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID");
			need("GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET");
			need("API_PUBLIC_URL", "API_PUBLIC_URL");
		}

		// The authorization code and the session cookies travel over this address.
		if (env.API_PUBLIC_URL && env.NODE_ENV === "production") {
			const url = new URL(env.API_PUBLIC_URL);
			if (url.protocol !== "https:" && !isLocal(url.hostname)) {
				ctx.addIssue({
					code: "custom",
					path: ["API_PUBLIC_URL"],
					message: "API_PUBLIC_URL must use https in production",
				});
			}
		}
	});

export const parseOAuthEnv = (source: Record<string, string | undefined> = process.env) =>
	parseEnv(oauthEnvSchema, "OAuth", source);

export const envOAuthConfig = Object.freeze(parseOAuthEnv());
