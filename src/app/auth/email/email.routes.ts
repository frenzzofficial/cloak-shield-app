import type { Elysia } from "elysia";

import { appConfig } from "../../../packages/configs/app.config";
import { authenticate } from "../../../packages/middlewares/authenticate";
import { rateLimiter } from "../../../packages/middlewares/rate-limiter-auth";
import { signInSchema, signUpSchema } from "../../../packages/schema/auth.schemas";

import {
	getMeHandler,
	listSessionsHandler,
	refreshHandler,
	signInHandler,
	signOutHandler,
	signUpHandler,
} from "./email.controllers";

export const registerEmailAuthRoutes = (app: Elysia): void => {
	app.group(appConfig.auth.authEmail.base, (auth) =>
		auth
			// Public authentication
			.use(rateLimiter)
			.post(appConfig.auth.authEmail.signup, signUpHandler, {
				body: signUpSchema,
			})
			.post(appConfig.auth.authEmail.signin, signInHandler, {
				body: signInSchema,
			})
			.post(appConfig.auth.authEmail.refresh, refreshHandler),
	);

	app.group(appConfig.auth.authEmail.base, (auth) =>
		auth
			// Authenticated routes
			.use(authenticate)
			.post(appConfig.auth.authEmail.signout, signOutHandler)
			.get(appConfig.auth.authEmail.me, getMeHandler)
			.get(appConfig.auth.authEmail.session, listSessionsHandler),
	);
};
