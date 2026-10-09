import type { Elysia } from "elysia";

import type { AuthCore } from "@/app/auth/core/plugin";
import { appConfig } from "@/packages/configs/app.config";
import { oauthLimiter } from "@/packages/middlewares/rate-limiter-auth";
import { logger } from "@/packages/utils/logger";
import {
	completeGoogleLogin,
	GOOGLE_PROVIDER_KEY,
	type GoogleDeps,
	recordGoogleFailure,
	startGoogleLogin,
} from "./google.services";

const route = appConfig.auth.authGoogle;

const detail = (summary: string, description: string) => ({ tags: ["Auth"], summary, description });

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 && value.length <= 2_048 ? value : undefined;

// Both routes are browser page loads (a button click and a provider redirect), not API calls, so
// they never answer with JSON: every outcome, good or bad, is a redirect to the frontend.
export const registerGoogleRoutes = (app: Elysia, core: AuthCore, deps: GoogleDeps): void => {
	app.group(route.path, (google) =>
		google
			.get(
				route.start,
				async ({ query, cookie, set, redirect }) => {
					const { location, sealedState } = await startGoogleLogin(deps, query.redirect);

					core.oauth.setStateCookie(cookie, GOOGLE_PROVIDER_KEY, route.path, sealedState);
					set.headers["cache-control"] = "no-store";

					return redirect(location);
				},
				{
					beforeHandle: oauthLimiter,
					detail: detail(
						"Sign in with Google",
						"Navigate the browser here. Redirects to Google, then back to the callback.",
					),
				},
			)
			.get(
				route.callback,
				async ({ query, cookie, request, server, set, redirect }) => {
					const device = core.device.extract(request, server);
					// Always read-and-clear first: whatever happens next, this state is spent.
					const sealedState = core.oauth.takeStateCookie(
						cookie,
						GOOGLE_PROVIDER_KEY,
						route.path,
					);
					set.headers["cache-control"] = "no-store";

					try {
						const result = await completeGoogleLogin({
							deps,
							core,
							query: {
								code: text(query.code),
								state: text(query.state),
								error: text(query.error),
							},
							sealedState,
							device,
						});

						if (result.kind === "success") {
							core.cookies.set(
								cookie,
								result.login.tokens,
								result.login.session.expiresAt,
							);
							return redirect(
								core.oauth.callbackUrl({
									status: "success",
									redirect: result.redirect,
								}),
							);
						}

						await recordGoogleFailure(core, device, result.error);
						return redirect(
							core.oauth.callbackUrl({ status: "error", error: result.error }),
						);
					} catch (error) {
						// A bug or an outage on our side. The user still lands back on the frontend,
						// with a code it can show, and the details stay in the log.
						logger.error("google sign-in crashed", {
							message: error instanceof Error ? error.message : String(error),
						});
						await recordGoogleFailure(core, device, "server_error");
						return redirect(
							core.oauth.callbackUrl({ status: "error", error: "server_error" }),
						);
					}
				},
				{
					beforeHandle: oauthLimiter,
					detail: detail(
						"Google sign-in callback",
						"Where Google sends the browser back. Redirects to the frontend with ?status=success or ?status=error&error=<code>.",
					),
				},
			),
	);
};
