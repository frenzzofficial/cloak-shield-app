import { Elysia } from "elysia";
import { verifyAccessToken } from "../utils/auth";
import { AppError } from "../utils/errors";

export const authenticate = new Elysia({
	name: "authenticate",
}).resolve({ as: "scoped" }, async ({ cookie: { access_token } }) => {
	const token = access_token?.value as string | undefined;

	if (!token) {
		throw AppError.unauthorized("Authentication required");
	}

	const user = await verifyAccessToken(token);

	return {
		user,
	};
});
