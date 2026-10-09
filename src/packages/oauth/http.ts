/** The part of fetch() the OAuth clients need; lets tests pass a fake provider with no network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A provider answered with an error status, or with something unusable. */
export class ProviderHttpError extends Error {
	readonly status: number;
	/** The OAuth `error` code, e.g. "invalid_grant", when the provider sent one. */
	readonly oauthError: string | undefined;

	constructor(status: number, oauthError?: string) {
		// No response body in the message: it can echo request details, and callers log this.
		super(`Provider request failed (HTTP ${status}${oauthError ? `, ${oauthError}` : ""})`);
		this.name = "ProviderHttpError";
		this.status = status;
		this.oauthError = oauthError;
	}
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** POSTs a form (the token endpoint) and returns the parsed JSON. */
export const postForm = async (
	url: string,
	form: Record<string, string>,
	options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<unknown> => {
	const { fetchImpl = (target, init) => fetch(target, init), timeoutMs = DEFAULT_TIMEOUT_MS } =
		options;

	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams(form).toString(),
		signal: AbortSignal.timeout(timeoutMs),
	});

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}

	if (!response.ok) {
		const code =
			typeof body === "object" &&
			body !== null &&
			"error" in body &&
			typeof body.error === "string"
				? body.error
				: undefined;
		throw new ProviderHttpError(response.status, code);
	}

	return body;
};
