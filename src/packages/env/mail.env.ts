import { z } from "zod";

import { parseEnv } from "../utils/parse-env";

// How outgoing email is delivered.
//   auto    - Resend when RESEND_API_KEY is set; otherwise print to the log (development)
//             or send nothing (production, with a warning)
//   resend  - Resend over HTTPS (needs RESEND_API_KEY and MAIL_FROM)
//   log     - print every message, links included, to the log (development only)
//   custom  - you call setMailer() at startup with your own transport (SMTP, SES, ...)
const mailEnvSchema = z
	.object({
		NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
		MAIL_TRANSPORT: z.enum(["auto", "resend", "log", "custom"]).default("auto"),
		RESEND_API_KEY: z.string().trim().min(1).optional(),
		// e.g. "Cloak Shield <no-reply@yourdomain.com>" (the domain must be verified in Resend)
		MAIL_FROM: z.string().trim().min(3).optional(),
	})
	.superRefine((env, ctx) => {
		const usesResend =
			env.MAIL_TRANSPORT === "resend" ||
			(env.MAIL_TRANSPORT === "auto" && env.RESEND_API_KEY !== undefined);

		if (usesResend && env.RESEND_API_KEY === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["RESEND_API_KEY"],
				message: "RESEND_API_KEY is required when MAIL_TRANSPORT=resend",
			});
		}

		if (usesResend && env.MAIL_FROM === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["MAIL_FROM"],
				message: "MAIL_FROM is required when sending through Resend",
			});
		}

		if (env.MAIL_TRANSPORT === "log" && env.NODE_ENV === "production") {
			ctx.addIssue({
				code: "custom",
				path: ["MAIL_TRANSPORT"],
				message:
					"MAIL_TRANSPORT=log would print verification and reset links to the production log",
			});
		}
	});

export const parseMailEnv = (source: Record<string, string | undefined> = process.env) =>
	parseEnv(mailEnvSchema, "Mail", source);

export const envMailConfig = Object.freeze(parseMailEnv());
