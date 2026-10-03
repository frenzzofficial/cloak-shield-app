import type { Mailer } from "./mailer";

/** The part of fetch() the transport needs; lets tests pass a fake without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ResendOptions {
	apiKey: string;
	from: string;
	timeoutMs?: number;
	fetchImpl?: FetchLike;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Sends through Resend's HTTP API. No SDK: one POST, so there is no extra dependency to
 * install, audit or keep updated. Throws on any non-2xx answer; callers treat mail as best
 * effort and log the failure without revealing it to the end user.
 */
export const createResendMailer = (options: ResendOptions): Mailer => {
	const {
		apiKey,
		from,
		timeoutMs = 10_000,
		fetchImpl = (url, init) => fetch(url, init),
	} = options;

	return {
		send: async (message) => {
			const response = await fetchImpl(RESEND_ENDPOINT, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					from,
					to: [message.to],
					subject: message.subject,
					text: message.text,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});

			if (!response.ok) {
				// The error body from Resend describes the problem and never echoes the key.
				const detail = (await response.text().catch(() => "")).slice(0, 300);
				throw new Error(`Resend rejected the email (HTTP ${response.status}): ${detail}`);
			}
		},
	};
};
