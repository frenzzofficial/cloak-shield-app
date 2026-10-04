import { AuditEvents } from "@/packages/configs/audit.config";
import { authConfig } from "@/packages/configs/auth.config";
import { AuthTokenTypes } from "@/packages/configs/auth-token.config";
import { getAuthRepository } from "@/packages/repository/drizzle/auth.repository";
import type {
	ForgotPasswordBody,
	ResendVerificationBody,
	ResetPasswordBody,
	SignInBody,
	SignUpBody,
	VerifyEmailBody,
} from "@/packages/schema/auth.schemas";
import type { User, UserSession } from "@/packages/schema/user.schema";
import {
	hashIdentifier,
	hashOpaqueToken,
	hashPassword,
	verifyAccessToken,
	verifyAgainstDummyHash,
	verifyPassword,
	verifyRefreshToken,
} from "@/packages/utils/auth";
import { bestEffort } from "@/packages/utils/best-effort";
import { isUniqueViolation } from "@/packages/utils/db-errors";
import { AppError } from "@/packages/utils/errors";
import { logger } from "@/packages/utils/logger";

const repo = () => getAuthRepository();

import { recordAudit } from "@/app/auth/core/audit.service";
import type { DeviceInfo, SessionTokens } from "@/app/auth/core/auth.types";
import {
	notifyPasswordChanged,
	sendResetLink,
	sendVerificationLink,
} from "@/app/auth/core/auth-mail";
import { issueEmailToken } from "@/app/auth/core/email-tokens";
import {
	buildSession,
	isBlocked,
	issueTokens,
	startSession,
} from "@/app/auth/core/session.service";

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

// One message for unknown email, wrong password AND locked account. Distinct messages would let
// anyone probe which emails are registered or which accounts are currently locked.
const invalidCredentials = (): AppError =>
	AppError.unauthorized(
		"Invalid email or password, or the account is temporarily locked after repeated failures",
	);

// ── Email delivery ─────────────────────────────────────────────────────────────

const sendVerificationEmail = async (user: User): Promise<void> => {
	const token = await issueEmailToken(
		user.id,
		AuthTokenTypes.EMAIL_VERIFICATION,
		authConfig.verifyTokenTtlSeconds,
	);
	await sendVerificationLink(user.email, token);
};

const sendPasswordResetEmail = async (user: User): Promise<void> => {
	const token = await issueEmailToken(
		user.id,
		AuthTokenTypes.PASSWORD_RESET,
		authConfig.resetTokenTtlSeconds,
	);
	await sendResetLink(user.email, token);
};

// ── Sign up ────────────────────────────────────────────────────────────────────

export const signUp = async (
	input: SignUpBody,
	device: DeviceInfo,
): Promise<{ user: User; login: SessionTokens | null }> => {
	const email = normalizeEmail(input.email);

	// NOTE: a distinct "already exists" answer lets callers test whether an email is
	// registered. Hiding that requires a verify-by-email-first sign-up (reply 202 either way and
	// mail the owner), which needs a real mail transport; see README "Known limitations".
	if (await repo().findUserByEmail(email)) {
		throw AppError.conflict("An account with this email already exists");
	}

	const now = new Date();
	const passwordHash = await hashPassword(input.password);
	const refreshTokenId = crypto.randomUUID();

	// With verification required, no session exists until the address is confirmed.
	const session = authConfig.requireEmailVerification
		? undefined
		: buildSession(
				"", // filled in by createUserWithSession once the user id is known
				device,
				authConfig.shortSessionTtlSeconds,
				refreshTokenId,
				now,
			);

	let user: User;
	try {
		user = await repo().createUserWithSession({
			user: {
				id: crypto.randomUUID(),
				fullname: input.fullname ?? null,
				email,
				avatarUrl: null,
				role: "USER",
				status: "PENDING_VERIFICATION",
				emailVerifiedAt: null,
				createdAt: now,
				updatedAt: now,
			},
			security: {
				userId: "", // filled in by createUserWithSession once the user id is known
				passwordHash,
				twoFactorEnabled: false,
				failedLoginAttempts: 0,
				lockedUntil: null,
				lastPasswordChangedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			profile: {
				userId: "",
				username: null,
				bio: null,
				phone: null,
				birthDate: null,
				gender: null,
				timezone: null,
				locale: null,
				website: null,
				twitterUrl: null,
				githubUrl: null,
				linkedinUrl: null,
				createdAt: now,
				updatedAt: now,
			},
			preferences: {
				userId: "",
				theme: "system",
				language: "en",
				emailNotifications: true,
				pushNotifications: true,
				marketingEmails: false,
				reducedMotion: false,
				highContrast: false,
				createdAt: now,
				updatedAt: now,
			},
			session,
		});
	} catch (error) {
		// Two sign-ups racing past the check above: the database's unique index decides.
		if (isUniqueViolation(error)) {
			throw AppError.conflict("An account with this email already exists");
		}
		throw error;
	}

	await recordAudit({ event: AuditEvents.SIGN_UP, userId: user.id, device });
	await bestEffort("verification email", () => sendVerificationEmail(user));

	if (!session) return { user, login: null };

	// The session row was created inside the transaction with `session.userId` filled in.
	const stored: UserSession = { ...session, userId: user.id };
	return {
		user,
		login: { tokens: await issueTokens(user, stored, refreshTokenId), session: stored },
	};
};

// ── Sign in ────────────────────────────────────────────────────────────────────

export const signIn = async (
	input: SignInBody,
	device: DeviceInfo,
): Promise<{ user: User; login: SessionTokens }> => {
	const email = normalizeEmail(input.email);
	const user = await repo().findUserByEmail(email);
	const security = user ? await repo().getUserSecurity(user.id) : undefined;

	// The trail records WHY a sign-in failed, but never the password, and for unknown accounts
	// only a keyed hash of the email (so repeated attempts can be correlated, not read).
	const failed = (reason: string, userId?: string) =>
		recordAudit({
			event: AuditEvents.SIGN_IN_FAILURE,
			outcome: "FAILURE",
			userId,
			device,
			metadata: { reason, ...(userId ? {} : { emailHash: hashIdentifier(email) }) },
		});

	if (!user || !security) {
		// Same argon2 cost as a real attempt, so response time does not reveal the email is unknown.
		await verifyAgainstDummyHash(input.password);
		await failed("unknown_email");
		throw invalidCredentials();
	}

	if (security.lockedUntil && security.lockedUntil.getTime() > Date.now()) {
		await verifyAgainstDummyHash(input.password);
		await failed("locked", user.id);
		throw invalidCredentials();
	}

	if (!(await verifyPassword(input.password, security.passwordHash))) {
		// Atomic in SQL: parallel guesses each count, and an expired lock restarts at 1.
		const updated = await repo().registerFailedLogin(
			user.id,
			authConfig.maxFailedLogins,
			authConfig.lockoutSeconds,
		);
		await failed("bad_password", user.id);

		// Exactly one request crosses the threshold, so the lock is recorded once.
		if (updated?.failedLoginAttempts === authConfig.maxFailedLogins) {
			await recordAudit({
				event: AuditEvents.ACCOUNT_LOCKED,
				outcome: "FAILURE",
				userId: user.id,
				device,
				metadata: { lockSeconds: authConfig.lockoutSeconds },
			});
		}
		throw invalidCredentials();
	}

	// From here on the caller has proven they own the account, so specific messages are safe.
	if (security.failedLoginAttempts > 0 || security.lockedUntil) {
		await repo().updateUserSecurity(user.id, { failedLoginAttempts: 0, lockedUntil: null });
	}

	if (isBlocked(user)) {
		await failed("inactive", user.id);
		throw AppError.forbidden("This account is no longer active");
	}

	if (authConfig.requireEmailVerification && user.status === "PENDING_VERIFICATION") {
		await failed("unverified", user.id);
		throw AppError.forbidden("Please verify your email address before signing in");
	}

	const login = await startSession(user, device, { remember: Boolean(input.remember) });

	return { user, login };
};

// ── Refresh ────────────────────────────────────────────────────────────────────

// Called when the presented token is not the session's current one. Two cases look identical on
// the wire but mean different things:
//   - rotated moments ago (two tabs refreshing at once): reject, keep the session; the winner's
//     new cookie is already on its way to the browser.
//   - replayed later: someone holds a copy of an old token, so the whole session is burned.
const rejectStaleRefresh = async (
	session: UserSession,
	presentedTokenId: string,
	device: DeviceInfo,
): Promise<never> => {
	const rotatedAt = session.refreshRotatedAt?.getTime() ?? 0;
	const justRotated =
		session.previousRefreshTokenId === presentedTokenId &&
		Date.now() - rotatedAt <= authConfig.refreshReuseGraceMs;

	if (justRotated) {
		throw AppError.unauthorized("Refresh token was just rotated; retry with the newest one");
	}

	await repo().revokeSession(session.id);
	logger.warn("refresh token reuse detected; session revoked", {
		sessionId: session.id,
		userId: session.userId,
	});
	await recordAudit({
		event: AuditEvents.REFRESH_REUSE_DETECTED,
		outcome: "FAILURE",
		userId: session.userId,
		device,
		metadata: { sessionId: session.id },
	});
	throw AppError.unauthorized("Refresh token reuse detected; please sign in again");
};

export const refresh = async (refreshToken: string, device: DeviceInfo): Promise<SessionTokens> => {
	const claims = await verifyRefreshToken(refreshToken);

	const session = await repo().getSession(claims.sessionId);
	if (!session || session.userId !== claims.userId) {
		throw AppError.unauthorized("Session no longer exists");
	}

	if (session.expiresAt.getTime() <= Date.now()) {
		await repo().revokeSession(session.id);
		throw AppError.unauthorized("Session has expired, please sign in again");
	}

	if (session.refreshTokenId !== claims.tokenId) {
		return rejectStaleRefresh(session, claims.tokenId, device);
	}

	const user = await repo().findUserById(claims.userId);
	if (!user) throw AppError.unauthorized("User no longer exists");

	if (isBlocked(user)) {
		await repo().revokeSession(session.id);
		throw AppError.forbidden("This account is no longer active");
	}

	const nextTokenId = crypto.randomUUID();
	const rotated = await repo().rotateRefreshToken(session.id, claims.tokenId, nextTokenId);

	// Lost a race with a parallel refresh of the same token.
	if (!rotated) {
		throw AppError.unauthorized("Refresh token was just rotated; retry with the newest one");
	}

	return { tokens: await issueTokens(user, rotated, nextTokenId), session: rotated };
};

// ── Sign out ───────────────────────────────────────────────────────────────────

const claimsFrom = async (tokens: {
	refreshToken?: string | undefined;
	accessToken?: string | undefined;
}): Promise<{ sessionId: string; userId: string } | undefined> => {
	if (tokens.refreshToken) {
		try {
			const { sessionId, userId } = await verifyRefreshToken(tokens.refreshToken);
			return { sessionId, userId };
		} catch {
			// fall through to the access token
		}
	}

	if (tokens.accessToken) {
		try {
			const { sessionId, userId } = await verifyAccessToken(tokens.accessToken);
			return { sessionId, userId };
		} catch {
			// nothing valid presented
		}
	}

	return undefined;
};

/**
 * Idempotent: signing out with an expired or missing token still succeeds (the caller's
 * cookies are cleared either way). A valid refresh OR access token revokes that session, so a
 * user whose access token has already expired can still sign out.
 */
export const signOut = async (
	tokens: {
		refreshToken?: string | undefined;
		accessToken?: string | undefined;
	},
	device: DeviceInfo,
): Promise<void> => {
	const claims = await claimsFrom(tokens);
	if (!claims) return;

	await repo().revokeSession(claims.sessionId);
	await recordAudit({ event: AuditEvents.SIGN_OUT, userId: claims.userId, device });
};

// ── Me / sessions ──────────────────────────────────────────────────────────────

export const getMe = async (userId: string): Promise<User> => {
	const user = await repo().findUserById(userId);
	if (!user) throw AppError.notFound("User not found");
	return user;
};

export const listSessions = async (userId: string): Promise<UserSession[]> => {
	const sessions = await repo().listSessionsForUser(userId);
	const now = Date.now();
	return sessions.filter((session) => session.expiresAt.getTime() > now);
};

// ── Email verification ─────────────────────────────────────────────────────────

export const verifyEmail = async (input: VerifyEmailBody, device: DeviceInfo): Promise<void> => {
	const consumed = await repo().consumeAuthToken(
		hashOpaqueToken(input.token),
		AuthTokenTypes.EMAIL_VERIFICATION,
	);
	const user = consumed ? await repo().markEmailVerified(consumed.userId) : undefined;

	if (!user) throw AppError.badRequest("This verification link is invalid or has expired");

	await recordAudit({ event: AuditEvents.EMAIL_VERIFIED, userId: user.id, device });
};

/** Always resolves the same way, whether or not the address has an account. */
export const resendVerification = async (input: ResendVerificationBody): Promise<void> => {
	await bestEffort("resend verification", async () => {
		const user = await repo().findUserByEmail(normalizeEmail(input.email));

		if (user && user.status === "PENDING_VERIFICATION" && user.emailVerifiedAt === null) {
			await sendVerificationEmail(user);
		}
	});
};

// ── Password reset ─────────────────────────────────────────────────────────────

/** Always resolves the same way, whether or not the address has an account. */
export const forgotPassword = async (
	input: ForgotPasswordBody,
	device: DeviceInfo,
): Promise<void> => {
	await bestEffort("password reset email", async () => {
		const user = await repo().findUserByEmail(normalizeEmail(input.email));

		if (user && !isBlocked(user)) {
			await sendPasswordResetEmail(user);
			await recordAudit({
				event: AuditEvents.PASSWORD_RESET_REQUESTED,
				userId: user.id,
				device,
			});
		}
	});
};

export const resetPassword = async (
	input: ResetPasswordBody,
	device: DeviceInfo,
): Promise<void> => {
	const consumed = await repo().consumeAuthToken(
		hashOpaqueToken(input.token),
		AuthTokenTypes.PASSWORD_RESET,
	);
	if (!consumed) throw AppError.badRequest("This reset link is invalid or has expired");

	const { userId } = consumed;
	const now = new Date();

	await repo().updateUserSecurity(userId, {
		passwordHash: await hashPassword(input.password),
		lastPasswordChangedAt: now,
		// Choosing a new password also clears any lockout caused by guessing the old one.
		failedLoginAttempts: 0,
		lockedUntil: null,
	});

	// Whoever knew the old password (or stole a session) must not stay signed in.
	await repo().deleteSessionsForUser(userId);
	await repo().deleteAuthTokensForUser(userId, AuthTokenTypes.PASSWORD_RESET);

	await recordAudit({ event: AuditEvents.PASSWORD_RESET_COMPLETED, userId, device });

	const user = await repo().findUserById(userId);
	if (user) await notifyPasswordChanged(user, device);
};
