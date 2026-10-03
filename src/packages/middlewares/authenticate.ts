import { Elysia } from "elysia";

import { getAuthRepository } from "@/packages/repository/drizzle/auth.repository";
import { verifyAccessToken } from "@/packages/utils/auth";
import { AppError } from "@/packages/utils/errors";

export const ACCESS_COOKIE = "access_token";

/** What every authenticated handler can rely on. Role and status come from the database. */
export interface AuthUser {
	userId: string;
	email: string;
	role: string;
	status: string;
	sessionId: string;
}

/** `Authorization: Bearer <token>` wins over the cookie, so API clients never need cookies. */
export const extractAccessToken = (
	authorization: string | undefined,
	cookieValue: unknown,
): string | undefined => {
	const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
	if (bearer) return bearer;
	return typeof cookieValue === "string" && cookieValue.length > 0 ? cookieValue : undefined;
};

/**
 * Verifies the access token AND that its session still exists, is unexpired, and belongs to an
 * active user. A JWT alone cannot be revoked, so without this check a signed-out or suspended
 * user would stay authenticated until the token's own expiry.
 */
export const authenticate = new Elysia({
	name: "authenticate",
}).resolve({ as: "scoped" }, async ({ cookie, headers }) => {
	const token = extractAccessToken(headers.authorization, cookie[ACCESS_COOKIE]?.value);

	if (!token) {
		throw AppError.unauthorized("Authentication required");
	}

	const claims = await verifyAccessToken(token);
	const found = await getAuthRepository().getSessionWithUser(claims.sessionId);

	if (
		!found ||
		found.session.userId !== claims.userId ||
		found.session.expiresAt.getTime() <= Date.now()
	) {
		throw AppError.unauthorized("Session is no longer valid");
	}

	if (found.user.status === "SUSPENDED" || found.user.status === "DEACTIVATED") {
		throw AppError.forbidden("This account is no longer active");
	}

	const user: AuthUser = {
		userId: found.user.id,
		email: found.user.email,
		role: found.user.role,
		status: found.user.status,
		sessionId: found.session.id,
	};

	return { user };
});
