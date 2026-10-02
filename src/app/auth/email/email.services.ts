import { getAuthRepository } from "../../../packages/repository/drizzle/auth.repository";
import type { SignInBody, SignUpBody } from "../../../packages/schema/auth.schemas";
import type { User, UserSession } from "../../../packages/schema/user.schema";
import {
	hashPassword,
	signAccessToken,
	signRefreshToken,
	verifyPassword,
	verifyRefreshToken,
} from "../../../packages/utils/auth";
import { AppError } from "../../../packages/utils/errors";

const repo = () => getAuthRepository();

export interface DeviceInfo {
	deviceName: string;
	platform: string;
	browser: string;
	os: string;
	ipAddress: string;
	userAgent: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches AUTH_REFRESH_TOKEN_TTL default

export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
}

const issueTokens = async (user: User, session: UserSession): Promise<AuthTokens> => {
	const [accessToken, refreshToken] = await Promise.all([
		signAccessToken({
			userId: user.id,
			email: user.email,
			role: user.role,
			sessionId: session.id,
		}),
		signRefreshToken({ userId: user.id, sessionId: session.id }),
	]);

	return { accessToken, refreshToken };
};

// ── Sign up ──────────────────────────────────────────────────────────────────

export const signUp = async (
	input: SignUpBody,
	device: DeviceInfo,
): Promise<{ user: User; tokens: AuthTokens }> => {
	const existing = await repo().findUserByEmail(input.email);
	if (existing) throw AppError.conflict("An account with this email already exists");

	const now = new Date();
	const passwordHash = await hashPassword(input.password);
	const sessionId = crypto.randomUUID();

	const user = await repo().createUserWithSession({
		user: {
			id: crypto.randomUUID(),
			fullname: input.fullname ?? "",
			email: input.email,
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
		session: {
			id: sessionId,
			userId: "",
			deviceName: device.deviceName,
			platform: device.platform,
			browser: device.browser,
			os: device.os,
			ipAddress: device.ipAddress,
			userAgent: device.userAgent,
			lastSeenAt: now,
			expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
			createdAt: now,
		},
	});

	const session = await repo().getSession(sessionId);
	if (!session) throw AppError.internal("Session was not created during sign up");

	const tokens = await issueTokens(user, session);
	return { user, tokens };
};

// ── Sign in ──────────────────────────────────────────────────────────────────

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export const signIn = async (
	input: SignInBody,
	device: DeviceInfo,
): Promise<{ user: User; tokens: AuthTokens }> => {
	const user = await repo().findUserByEmail(input.email);
	if (!user) throw AppError.unauthorized("Invalid email or password");

	const security = await repo().getUserSecurity(user.id);
	if (!security) throw AppError.internal("User is missing a security record");

	if (security.lockedUntil && security.lockedUntil.getTime() > Date.now()) {
		throw AppError.forbidden("Account temporarily locked due to too many failed attempts");
	}

	if (user.status === "SUSPENDED" || user.status === "DEACTIVATED") {
		throw AppError.forbidden("This account is no longer active");
	}

	const validPassword = await verifyPassword(input.password, security.passwordHash);

	if (!validPassword) {
		const failedLoginAttempts = security.failedLoginAttempts + 1;
		const lockedUntil =
			failedLoginAttempts >= MAX_FAILED_ATTEMPTS
				? new Date(Date.now() + LOCK_DURATION_MS)
				: null;

		await repo().updateUserSecurity(user.id, {
			failedLoginAttempts,
			lockedUntil,
		});
		throw AppError.unauthorized("Invalid email or password");
	}

	if (security.failedLoginAttempts > 0) {
		await repo().updateUserSecurity(user.id, {
			failedLoginAttempts: 0,
			lockedUntil: null,
		});
	}

	const now = new Date();
	const ttl = input.remember ? SESSION_TTL_MS : 24 * 60 * 60 * 1000; // 1 day if not "remember me"

	const session = await repo().createSession({
		id: crypto.randomUUID(),
		userId: user.id,
		deviceName: device.deviceName,
		platform: device.platform,
		browser: device.browser,
		os: device.os,
		ipAddress: device.ipAddress,
		userAgent: device.userAgent,
		lastSeenAt: now,
		expiresAt: new Date(now.getTime() + ttl),
		createdAt: now,
	});

	const tokens = await issueTokens(user, session);
	return { user, tokens };
};

// ── Refresh ──────────────────────────────────────────────────────────────────

export const refresh = async (refreshToken: string): Promise<AuthTokens> => {
	const payload = await verifyRefreshToken(refreshToken);

	const session = await repo().getSession(payload.sessionId);
	if (!session || session.userId !== payload.userId) {
		throw AppError.unauthorized("Session no longer exists");
	}

	if (session.expiresAt.getTime() < Date.now()) {
		await repo()
			.revokeSession(session.id)
			.catch(() => undefined);
		throw AppError.unauthorized("Session has expired, please sign in again");
	}

	const user = await repo().findUserById(payload.userId);
	if (!user) throw AppError.unauthorized("User no longer exists");

	return issueTokens(user, session);
};

// ── Sign out ─────────────────────────────────────────────────────────────────

export const signOut = async (sessionId: string): Promise<void> => {
	await repo().revokeSession(sessionId);
};

// ── Me / sessions ────────────────────────────────────────────────────────────

export const getMe = async (userId: string): Promise<User> => {
	const user = await repo().findUserById(userId);
	if (!user) throw AppError.notFound("User not found");
	return user;
};

export const listSessions = async (userId: string): Promise<UserSession[]> => {
	return repo().listSessionsForUser(userId);
};
