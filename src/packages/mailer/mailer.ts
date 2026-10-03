import { envAuthConfig } from "@/packages/env/auth.env";
import { logger } from "@/packages/utils/logger";

export interface MailMessage {
	to: string;
	subject: string;
	text: string;
}

/**
 * Anything that can deliver an email. Plug a real transport in at startup with setMailer()
 * (SMTP, Resend, SES, ...). No transport ships by default so the project stays dependency-free.
 */
export interface Mailer {
	send(message: MailMessage): Promise<void>;
}

/** Development/test transport: prints the whole message, links included, to the log. */
const logMailer: Mailer = {
	send: async (message) => {
		logger.info("email (dev transport, not delivered)", { ...message });
	},
};

/**
 * Production fallback when no transport was configured. It must NOT log the body: the body
 * contains live verification / reset links, and logs are not a safe place for them.
 */
const unconfiguredMailer: Mailer = {
	send: async (message) => {
		logger.warn("email not sent: no mail transport configured (call setMailer at startup)", {
			to: message.to,
			subject: message.subject,
		});
	},
};

let current: Mailer = envAuthConfig.NODE_ENV === "production" ? unconfiguredMailer : logMailer;

export const getMailer = (): Mailer => current;

export const setMailer = (mailer: Mailer): void => {
	current = mailer;
};
