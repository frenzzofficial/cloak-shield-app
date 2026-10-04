import { AuditEvents } from "@/packages/configs/audit.config";
import { authConfig } from "@/packages/configs/auth.config";
import { getAuthRepository } from "@/packages/repository/drizzle/auth.repository";
import type { User } from "@/packages/schema/user.schema";
import { verifyPassword } from "@/packages/utils/auth";
import { AppError } from "@/packages/utils/errors";
import { recordAudit } from "./audit.service";
import type { DeviceInfo } from "./auth.types";

// Re-authentication for sensitive actions (change password / email, delete account). It lives in
// core rather than in the email plugin because every sign-in method eventually needs it, and
// because account routes depend on it.

const repo = () => getAuthRepository();

export interface AuthContext {
	userId: string;
	sessionId: string;
}

/**
 * Re-authentication. The password check feeds the SAME failed-attempt counter as sign-in: if
 * it did not, a stolen session could guess the password through these endpoints with no limit.
 */
export const requirePassword = async (
	userId: string,
	password: string,
	device: DeviceInfo,
	action: string,
): Promise<User> => {
	const [user, security] = await Promise.all([
		repo().findUserById(userId),
		repo().getUserSecurity(userId),
	]);
	if (!user || !security) throw AppError.unauthorized("Account not found");

	if (security.lockedUntil && security.lockedUntil.getTime() > Date.now()) {
		throw AppError.tooManyRequests("Too many failed attempts. Try again later.");
	}

	if (!(await verifyPassword(password, security.passwordHash))) {
		const updated = await repo().registerFailedLogin(
			userId,
			authConfig.maxFailedLogins,
			authConfig.lockoutSeconds,
		);
		await recordAudit({
			event: AuditEvents.REAUTH_FAILURE,
			outcome: "FAILURE",
			userId,
			device,
			metadata: { action },
		});

		if (updated?.failedLoginAttempts === authConfig.maxFailedLogins) {
			await recordAudit({
				event: AuditEvents.ACCOUNT_LOCKED,
				outcome: "FAILURE",
				userId,
				device,
				metadata: { lockSeconds: authConfig.lockoutSeconds },
			});
		}
		throw AppError.forbidden("Current password is incorrect");
	}

	if (security.failedLoginAttempts > 0 || security.lockedUntil) {
		await repo().updateUserSecurity(userId, { failedLoginAttempts: 0, lockedUntil: null });
	}

	return user;
};
