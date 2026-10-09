import { AuditEvents } from "../../../packages/configs/audit.config";
import { authConfig } from "../../../packages/configs/auth.config";
import { getAuthRepository } from "../../../packages/repository/drizzle/auth.repository";
import type { User } from "../../../packages/schema/user.schema";
import { verifyPassword } from "../../../packages/utils/auth";
import { AppError } from "../../../packages/utils/errors";
import { recordAudit } from "./audit.service";
import type { DeviceInfo } from "./auth.types";

// Re-authentication for sensitive actions (change password / email, delete account). It lives in
// core rather than in the email plugin because every sign-in method needs it, and because the
// account routes depend on it.
//
// How a user proves they are still themselves depends on what they can prove:
//   - an account with a password: the current password, counted against the same lockout as sign-in
//   - an account without one (Google/Discord only): a sign-in no older than AUTH_REAUTH_WINDOW

const repo = () => getAuthRepository();

export interface AuthContext {
	userId: string;
	sessionId: string;
}

const requireRecentSignIn = async (
	user: User,
	sessionId: string,
	device: DeviceInfo,
	action: string,
): Promise<User> => {
	const session = await repo().getSession(sessionId);
	// A refresh keeps the same session row, so refreshing never counts as signing in again.
	const age = session ? Date.now() - session.createdAt.getTime() : Number.POSITIVE_INFINITY;

	if (age > authConfig.reauthWindowSeconds * 1_000) {
		await recordAudit({
			event: AuditEvents.REAUTH_FAILURE,
			outcome: "FAILURE",
			userId: user.id,
			device,
			metadata: { action, reason: "stale_session" },
		});
		throw AppError.forbidden("Recent sign-in required. Sign in again to continue.");
	}

	return user;
};

/**
 * Proves the caller is still the account owner. The password check feeds the SAME failed-attempt
 * counter as sign-in: if it did not, a stolen session could guess the password through these
 * endpoints with no limit.
 */
export const requireReauth = async (
	auth: AuthContext,
	password: string | undefined,
	device: DeviceInfo,
	action: string,
): Promise<User> => {
	const [user, security] = await Promise.all([
		repo().findUserById(auth.userId),
		repo().getUserSecurity(auth.userId),
	]);
	if (!user || !security) throw AppError.unauthorized("Account not found");

	// No password on the account: a password typed here would mean nothing, so it is not consulted.
	if (security.passwordHash === null) {
		return requireRecentSignIn(user, auth.sessionId, device, action);
	}

	if (password === undefined) {
		// Leaving the field out is not a guess, so it does not count toward the lockout.
		throw AppError.forbidden("Current password is required");
	}

	if (security.lockedUntil && security.lockedUntil.getTime() > Date.now()) {
		throw AppError.tooManyRequests("Too many failed attempts. Try again later.");
	}

	if (!(await verifyPassword(password, security.passwordHash))) {
		const updated = await repo().registerFailedLogin(
			auth.userId,
			authConfig.maxFailedLogins,
			authConfig.lockoutSeconds,
		);
		await recordAudit({
			event: AuditEvents.REAUTH_FAILURE,
			outcome: "FAILURE",
			userId: auth.userId,
			device,
			metadata: { action },
		});

		if (updated?.failedLoginAttempts === authConfig.maxFailedLogins) {
			await recordAudit({
				event: AuditEvents.ACCOUNT_LOCKED,
				outcome: "FAILURE",
				userId: auth.userId,
				device,
				metadata: { lockSeconds: authConfig.lockoutSeconds },
			});
		}
		throw AppError.forbidden("Current password is incorrect");
	}

	if (security.failedLoginAttempts > 0 || security.lockedUntil) {
		await repo().updateUserSecurity(auth.userId, { failedLoginAttempts: 0, lockedUntil: null });
	}

	return user;
};
