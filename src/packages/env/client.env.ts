import { z } from "zod";

import { parseEnv } from "../utils/parse-env";

const clientEnvSchema = z.object({
	// Primary frontend origin
	CLIENT_ORIGIN: z.url().trim().default("http://localhost:3000"),

	// Frontend API URL
	CLIENT_API_ORIGIN: z.url().trim().default("http://localhost:3000/api"),

	// Comma-separated allowlist of frontend origins.
	// Example:
	// https://app.example.com,https://staging.example.com,http://localhost:3000
	CLIENT_ORIGINS: z
		.string()
		.trim()
		.default("http://localhost:3000")
		.transform((value) =>
			value
				.split(",")
				.map((origin) => origin.trim())
				.filter(Boolean),
		)
		.pipe(z.array(z.url())),
});

/**
 * Public, immutable config.
 */
export const envClientConfig = Object.freeze(parseEnv(clientEnvSchema, "Client"));

export type EnvClientConfig = typeof envClientConfig;
