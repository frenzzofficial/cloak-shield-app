import { AuditEvents } from "@/packages/configs/audit.config";
import { authConfig } from "@/packages/configs/auth.config";
import { AuthTokenTypes } from "@/packages/configs/auth-token.config";
import { getAuthRepository } from "@/packages/repository/drizzle/auth.repository";
import type {
	ActivityQuery,
	ChangeEmailBody,
	ChangePasswordBody,
	ConfirmEmailChangeBody,
} from "@/packages/schema/auth.schemas";
import type { AuditLogRecord, User } from "@/packages/schema/user.schema";
import { hashOpaqueToken, hashPassword, verifyPassword } from "@/packages/utils/auth";
import { isUniqueViolation } from "@/packages/utils/db-errors";
import { AppError } from "@/packages/utils/errors";
import { recordAudit } from "../audit.service";
import type { DeviceInfo } from "../auth.types";
import {
	notifyEmailChanged,
	notifyEmailChangeRequested,
	notifyPasswordChanged,
	sendEmailChangeLink,
} from "../auth-mail";
import { issueEmailToken } from "../email-tokens";

// Actions that need the CURRENT password again (change password / email, delete account) plus
// session control and the activity feed. Everything here acts on an already signed-in user.

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

// ── Change password ────────────────────────────────────────────────────────────

export const changePassword = async (
	auth: AuthContext,
	input: ChangePasswordBody,
	device: DeviceInfo,
): Promise<{ revokedSessions: number }> => {
	const user = await requirePassword(
		auth.userId,
		input.currentPassword,
		device,
		"change_password",
	);

	await repo().updateUserSecurity(auth.userId, {
		passwordHash: await hashPassword(input.newPassword),
		lastPasswordChangedAt: new Date(),
	});

	// Keep this device signed in; end every other session and any pending reset link.
	const revokedSessions = await repo().revokeOtherSessions(auth.userId, auth.sessionId);
	await repo().deleteAuthTokensForUser(auth.userId, AuthTokenTypes.PASSWORD_RESET);

	await recordAudit({
		event: AuditEvents.PASSWORD_CHANGED,
		userId: auth.userId,
		device,
		metadata: { revokedSessions },
	});
	await notifyPasswordChanged(user, device);

	return { revokedSessions };
};

// ── Change email ───────────────────────────────────────────────────────────────

export const changeEmail = async (
	auth: AuthContext,
	input: ChangeEmailBody,
	device: DeviceInfo,
): Promise<void> => {
	const user = await requirePassword(auth.userId, input.password, device, "change_email");
	const newEmail = input.newEmail.trim().toLowerCase();

	if (newEmail === user.email) {
		throw AppError.badRequest("That is already your email address");
	}

	// The caller is signed in and has proven their password, so a plain conflict answer is fine.
	if (await repo().findUserByEmail(newEmail)) {
		throw AppError.conflict("An account with this email already exists");
	}

	const token = await issueEmailToken(
		user.id,
		AuthTokenTypes.EMAIL_CHANGE,
		authConfig.verifyTokenTtlSeconds,
		newEmail,
	);

	await recordAudit({
		event: AuditEvents.EMAIL_CHANGE_REQUESTED,
		userId: user.id,
		device,
	});

	// The link goes to the NEW address (proof they control it); the OLD address is warned so a
	// hijacked session cannot quietly redirect the account.
	await sendEmailChangeLink(newEmail, token);
	await notifyEmailChangeRequested(user, newEmail);
};

export const confirmEmailChange = async (
	input: ConfirmEmailChangeBody,
	device: DeviceInfo,
): Promise<void> => {
	const consumed = await repo().consumeAuthToken(
		hashOpaqueToken(input.token),
		AuthTokenTypes.EMAIL_CHANGE,
	);
	if (!consumed?.newEmail) {
		throw AppError.badRequest("This confirmation link is invalid or has expired");
	}

	const before = await repo().findUserById(consumed.userId);
	if (!before) throw AppError.badRequest("This confirmation link is invalid or has expired");

	try {
		await repo().changeUserEmail(consumed.userId, consumed.newEmail);
	} catch (error) {
		// Someone else registered the address between the request and the click.
		if (isUniqueViolation(error)) {
			throw AppError.conflict("That email address is no longer available");
		}
		throw error;
	}

	// An email change is an account-takeover shape, so every device signs in again.
	await repo().deleteSessionsForUser(consumed.userId);
	await repo().deleteAuthTokensForUser(consumed.userId, AuthTokenTypes.EMAIL_VERIFICATION);

	await recordAudit({ event: AuditEvents.EMAIL_CHANGED, userId: consumed.userId, device });
	await notifyEmailChanged(before.email, consumed.newEmail);
};

// ── Session control ────────────────────────────────────────────────────────────

export const revokeSession = async (
	auth: AuthContext,
	targetSessionId: string,
	device: DeviceInfo,
): Promise<{ revokedCurrent: boolean }> => {
	// Scoped to the caller's own sessions: someone else's id is simply "not found".
	if (!(await repo().revokeSessionForUser(auth.userId, targetSessionId))) {
		throw AppError.notFound("Session not found");
	}

	await recordAudit({
		event: AuditEvents.SESSION_REVOKED,
		userId: auth.userId,
		device,
		metadata: { sessionId: targetSessionId },
	});

	return { revokedCurrent: targetSessionId === auth.sessionId };
};

export const revokeOtherSessions = async (
	auth: AuthContext,
	device: DeviceInfo,
): Promise<{ revokedSessions: number }> => {
	const revokedSessions = await repo().revokeOtherSessions(auth.userId, auth.sessionId);

	await recordAudit({
		event: AuditEvents.OTHER_SESSIONS_REVOKED,
		userId: auth.userId,
		device,
		metadata: { revokedSessions },
	});

	return { revokedSessions };
};

// ── Activity feed ──────────────────────────────────────────────────────────────

export const listActivity = async (
	userId: string,
	query: ActivityQuery,
): Promise<AuditLogRecord[]> =>
	repo().listAuditLogsForUser(userId, {
		limit: query.limit,
		before: query.before ? new Date(query.before) : undefined,
	});
