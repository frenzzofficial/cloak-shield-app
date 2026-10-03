import { envMailConfig } from "@/packages/env/mail.env";
import { logger } from "@/packages/utils/logger";
import { createResendMailer } from "./resend";

export interface MailMessage {
	to: string;
	subject: string;
	text: string;
}

/**
 * Anything that can deliver an email. Resend ships built in (see MAIL_TRANSPORT); for SMTP, SES
 * or anything else call setMailer() once at startup.
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
 * Fallback when no transport is configured. It must NOT log the body: the body contains live
 * verification / reset links, and logs are not a safe place for them.
 */
const unconfiguredMailer: Mailer = {
	send: async (message) => {
		logger.warn("email not sent: no mail transport configured (see MAIL_TRANSPORT)", {
			to: message.to,
			subject: message.subject,
		});
	},
};

const resolveMailer = (): Mailer => {
	const { MAIL_TRANSPORT, RESEND_API_KEY, MAIL_FROM, NODE_ENV } = envMailConfig;

	if (RESEND_API_KEY && MAIL_FROM && (MAIL_TRANSPORT === "resend" || MAIL_TRANSPORT === "auto")) {
		return createResendMailer({ apiKey: RESEND_API_KEY, from: MAIL_FROM });
	}

	if (MAIL_TRANSPORT === "log") return logMailer;
	if (MAIL_TRANSPORT === "custom") return unconfiguredMailer;
	return NODE_ENV === "production" ? unconfiguredMailer : logMailer;
};

let current: Mailer = resolveMailer();

export const getMailer = (): Mailer => current;

export const setMailer = (mailer: Mailer): void => {
	current = mailer;
};
