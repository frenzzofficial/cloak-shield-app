import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

import type { AuthPlugin } from "@/app/auth/core/plugin";
import { appConfig } from "@/packages/configs/app.config";
import { envOAuthConfig } from "@/packages/env/oauth.env";
import type { FetchLike } from "@/packages/oauth/http";
import { GOOGLE_JWKS_URL } from "./google.client";
import { registerGoogleRoutes } from "./google.routes";

export interface GooglePluginOptions {
	enabled: boolean;
	clientId: string;
	clientSecret: string;
	/** The public address of this API (see API_PUBLIC_URL). */
	apiPublicUrl: string;
	/** Injectable so tests can run a whole sign-in with no network. */
	fetchImpl?: FetchLike;
	jwks?: JWTVerifyGetKey;
}

const route = appConfig.auth.authGoogle;

export const createGooglePlugin = (options: GooglePluginOptions): AuthPlugin => ({
	id: "google",
	kind: "oauth",
	label: "Google",
	startPath: `${route.path}${route.start}`,
	enabled: options.enabled,
	// Google signs the user in; refresh, sign-out and /me still come from elsewhere (see plugin.ts).
	requires: ["session-routes"],
	register: (app, core) => {
		registerGoogleRoutes(app, core, {
			clientId: options.clientId,
			clientSecret: options.clientSecret,
			redirectUri: `${options.apiPublicUrl}${route.path}${route.callback}`,
			// Created here, not at import: a deployment without Google never builds it. jose fetches
			// and caches Google's signing keys on first use and re-fetches when a new key id appears.
			jwks:
				options.jwks ??
				createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
					timeoutDuration: 5_000,
					cooldownDuration: 30_000,
				}),
			fetchImpl: options.fetchImpl,
		});
	},
});

// The real instance, configured from the environment. Disabled (and needing no configuration)
// unless ENABLE_GOOGLE_AUTH=true.
export const googlePlugin: AuthPlugin = createGooglePlugin({
	enabled: envOAuthConfig.ENABLE_GOOGLE_AUTH,
	clientId: envOAuthConfig.GOOGLE_CLIENT_ID ?? "",
	clientSecret: envOAuthConfig.GOOGLE_CLIENT_SECRET ?? "",
	apiPublicUrl: envOAuthConfig.API_PUBLIC_URL ?? "",
});
