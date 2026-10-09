import { z } from "zod";

import { type FetchLike, postForm } from "@/packages/oauth/http";

// Everything that is specific to Google's endpoints. Nothing here touches accounts or sessions.

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

// Google documents both spellings of its issuer.
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;

export const buildAuthorizationUrl = (params: {
	clientId: string;
	redirectUri: string;
	state: string;
	nonce: string;
	codeChallenge: string;
}): string => {
	const url = new URL(GOOGLE_AUTH_URL);

	url.searchParams.set("client_id", params.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("response_type", "code");
	// Identity only: who is this and what is their (verified) email. No Google API access.
	url.searchParams.set("scope", "openid email profile");
	url.searchParams.set("state", params.state);
	url.searchParams.set("nonce", params.nonce);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	// Always show the account chooser: signing in as whoever Google happens to have cached is how
	// people end up in the wrong account on a shared computer.
	url.searchParams.set("prompt", "select_account");

	return url.toString();
};

const tokenResponseSchema = z.object({ id_token: z.string().min(1) });

/** Trades the one-time authorization code for an ID token. Sends the PKCE verifier. */
export const exchangeAuthorizationCode = async (params: {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	code: string;
	verifier: string;
	fetchImpl?: FetchLike | undefined;
}): Promise<string> => {
	const body = await postForm(
		GOOGLE_TOKEN_URL,
		{
			grant_type: "authorization_code",
			code: params.code,
			redirect_uri: params.redirectUri,
			client_id: params.clientId,
			client_secret: params.clientSecret,
			code_verifier: params.verifier,
		},
		params.fetchImpl ? { fetchImpl: params.fetchImpl } : {},
	);

	// Only the ID token is used: the access token would grant API access we never asked for.
	return tokenResponseSchema.parse(body).id_token;
};
