import { authConfig } from "@/packages/configs/auth.config";
import { type AuthTokenType, AuthTokenTypes } from "@/packages/configs/auth-token.config";
import { envClientConfig } from "@/packages/env/client.env";
import { getMailer } from "@/packages/mailer/mailer";
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
	generateOpaqueToken,
	hashOpaqueToken,
	hashPassword,
	signAccessToken,
	signRefreshToken,
	verifyAccessToken,
	verifyAgainstDummyHash,
	verifyPassword,
	verifyRefreshToken,
} from "@/packages/utils/auth";
import { isUniqueViolation } from "@/packages/utils/db-errors";
import { AppError } from "@/packages/utils/errors";
import { logger } from "@/packages/utils/logger";

const repo = () => getAuthRepository();

export interface DeviceInfo {
	deviceName: string;
	platform: string;
	browser: string;
	os: string;
	ipAddress: string;
	userAgent: string;
}

export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
}

/** A freshly issued login: the tokens plus the session they belong to (its expiry drives cookies). */
export interface SessionTokens {
	tokens: AuthTokens;
	session: UserSession;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const isBlocked = (user: User): boolean =>
	user.status === "SUSPENDED" || user.status === "DEACTIVATED";

// One message for unknown email, wrong password AND locked account. Distinct messages would let
// anyone probe which emails are registered or which accounts are currently locked.
const invalidCredentials = (): AppError =>
	AppError.unauthorized(
		"Invalid email or password, or the account is temporarily locked after repeated failures",
	);

const buildSession = (
	userId: string,
	device: DeviceInfo,
	ttlSeconds: number,
	refreshTokenId: string,
	now: Date,
): UserSession => ({
	id: crypto.randomUUID(),
	userId,
	deviceName: device.deviceName,
	platform: device.platform,
	browser: device.browser,
	os: device.os,
	ipAddress: device.ipAddress,
	userAgent: device.userAgent,
	refreshTokenId,
	previousRefreshTokenId: null,
	refreshRotatedAt: null,
	lastSeenAt: now,
	expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
	createdAt: now,
});

const issueTokens = async (
	user: User,
	session: UserSession,
	refreshTokenId: string,
): Promise<AuthTokens> => {
	const [accessToken, refreshToken] = await Promise.all([
		signAccessToken({
			userId: user.id,
			email: user.email,
			role: user.role,
			sessionId: session.id,
		}),
		signRefreshToken(
			{ userId: user.id, sessionId: session.id, tokenId: refreshTokenId },
			session.expiresAt,
		),
	]);

	return { accessToken, refreshToken };
};

// ── Email delivery ─────────────────────────────────────────────────────────────

// Mail problems must never change an endpoint's response: a visible failure for some emails
// but not others would leak which addresses have accounts, and a sign-up should not fail
// because the mail provider hiccuped.
const bestEffort = async (label: string, task: () => Promise<void>): Promise<void> => {
	try {
		await task();
	} catch (error) {
		logger.error(`${label} failed`, {
			message: error instanceof Error ? error.message : String(error),
		});
	}
};

const issueEmailToken = async (
	user: User,
	type: AuthTokenType,
	ttlSeconds: number,
): Promise<string> => {
	// Only the newest link works: requesting another invalidates the previous one.
	await repo().deleteAuthTokensForUser(user.id, type);

	const token = generateOpaqueToken();
	const now = new Date();

	await repo().createAuthToken({
		id: crypto.randomUUID(),
		userId: user.id,
		type,
		tokenHash: hashOpaqueToken(token),
		expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
		usedAt: null,
		createdAt: now,
	});

	return token;
};

const sendVerificationEmail = async (user: User): Promise<void> => {
	const token = await issueEmailToken(
		user,
		"EMAIL_VERIFICATION",
		authConfig.verifyTokenTtlSeconds,
	);
	const link = `${envClientConfig.CLIENT_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`;

	await getMailer().send({
		to: user.email,
		subject: "Verify your email address",
		text: `Confirm your email address by opening this link:\n\n${link}\n\nIf you did not create an account, you can ignore this message.`,
	});
};

const sendPasswordResetEmail = async (user: User): Promise<void> => {
	const token = await issueEmailToken(
		user,
		AuthTokenTypes.PASSWORD_RESET,
		authConfig.resetTokenTtlSeconds,
	);
	const link = `${envClientConfig.CLIENT_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;

	await getMailer().send({
		to: user.email,
		subject: "Reset your password",
		text: `Choose a new password by opening this link:\n\n${link}\n\nIf you did not ask for this, you can ignore this message; your password has not changed.`,
	});
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
	const user = await repo().findUserByEmail(normalizeEmail(input.email));
	const security = user ? await repo().getUserSecurity(user.id) : undefined;

	if (!user || !security) {
		// Same argon2 cost as a real attempt, so response time does not reveal the email is unknown.
		await verifyAgainstDummyHash(input.password);
		throw invalidCredentials();
	}

	if (security.lockedUntil && security.lockedUntil.getTime() > Date.now()) {
		await verifyAgainstDummyHash(input.password);
		throw invalidCredentials();
	}

	if (!(await verifyPassword(input.password, security.passwordHash))) {
		// Atomic in SQL: parallel guesses each count, and an expired lock restarts at 1.
		await repo().registerFailedLogin(
			user.id,
			authConfig.maxFailedLogins,
			authConfig.lockoutSeconds,
		);
		throw invalidCredentials();
	}

	// From here on the caller has proven they own the account, so specific messages are safe.
	if (security.failedLoginAttempts > 0 || security.lockedUntil) {
		await repo().updateUserSecurity(user.id, { failedLoginAttempts: 0, lockedUntil: null });
	}

	if (isBlocked(user)) {
		throw AppError.forbidden("This account is no longer active");
	}

	if (authConfig.requireEmailVerification && user.status === "PENDING_VERIFICATION") {
		throw AppError.forbidden("Please verify your email address before signing in");
	}

	const now = new Date();
	const refreshTokenId = crypto.randomUUID();
	const ttl = input.remember
		? authConfig.longSessionTtlSeconds
		: authConfig.shortSessionTtlSeconds;

	await repo().deleteExpiredSessionsForUser(user.id);
	const session = await repo().createSession(
		buildSession(user.id, device, ttl, refreshTokenId, now),
	);
	await repo().trimSessionsForUser(user.id, authConfig.maxSessionsPerUser);

	return {
		user,
		login: { tokens: await issueTokens(user, session, refreshTokenId), session },
	};
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
	throw AppError.unauthorized("Refresh token reuse detected; please sign in again");
};

export const refresh = async (refreshToken: string): Promise<SessionTokens> => {
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
		return rejectStaleRefresh(session, claims.tokenId);
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

const sessionIdFrom = async (tokens: {
	refreshToken?: string | undefined;
	accessToken?: string | undefined;
}): Promise<string | undefined> => {
	if (tokens.refreshToken) {
		try {
			return (await verifyRefreshToken(tokens.refreshToken)).sessionId;
		} catch {
			// fall through to the access token
		}
	}

	if (tokens.accessToken) {
		try {
			return (await verifyAccessToken(tokens.accessToken)).sessionId;
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
export const signOut = async (tokens: {
	refreshToken?: string | undefined;
	accessToken?: string | undefined;
}): Promise<void> => {
	const sessionId = await sessionIdFrom(tokens);
	if (sessionId) await repo().revokeSession(sessionId);
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

export const verifyEmail = async (input: VerifyEmailBody): Promise<void> => {
	const userId = await repo().consumeAuthToken(
		hashOpaqueToken(input.token),
		"EMAIL_VERIFICATION",
	);
	const user = userId ? await repo().markEmailVerified(userId) : undefined;

	if (!user) throw AppError.badRequest("This verification link is invalid or has expired");
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
export const forgotPassword = async (input: ForgotPasswordBody): Promise<void> => {
	await bestEffort("password reset email", async () => {
		const user = await repo().findUserByEmail(normalizeEmail(input.email));

		if (user && !isBlocked(user)) {
			await sendPasswordResetEmail(user);
		}
	});
};

export const resetPassword = async (input: ResetPasswordBody): Promise<void> => {
	const userId = await repo().consumeAuthToken(
		hashOpaqueToken(input.token),
		AuthTokenTypes.PASSWORD_RESET,
	);
	if (!userId) throw AppError.badRequest("This reset link is invalid or has expired");

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
};
