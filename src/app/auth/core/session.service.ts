import { AuditEvents } from "../../../packages/configs/audit.config";
import { authConfig } from "../../../packages/configs/auth.config";
import { getAuthRepository } from "../../../packages/repository/drizzle/auth.repository";
import type { User, UserSession } from "../../../packages/schema/user.schema";
import { signAccessToken, signRefreshToken } from "../../../packages/utils/auth";
import { recordAudit } from "./audit.service";
import type { AuthTokens, DeviceInfo, SessionTokens } from "./auth.types";
import { notifyNewDevice } from "./auth-mail";

// Everything a sign-in method needs once it has decided "this person is who they claim to be":
// create the session, sign the tokens, keep the session table tidy, leave an audit row, and
// warn about unfamiliar devices. Email today, Google and Discord next: none of them should
// re-implement any of it.

const repo = () => getAuthRepository();

/** Suspended and deactivated accounts can never sign in, whatever the method. */
export const isBlocked = (user: User): boolean =>
	user.status === "SUSPENDED" || user.status === "DEACTIVATED";

export const buildSession = (
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

export const issueTokens = async (
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

export interface StartSessionOptions {
	/** Long session (remember me) or the short one. */
	remember: boolean;
	/** Extra fields for the SIGN_IN_SUCCESS audit row, e.g. which provider was used. */
	metadata?: Record<string, unknown>;
}

/**
 * Opens a session for a user whose identity the caller has ALREADY verified, and returns the
 * tokens. The caller is responsible for the checks that are specific to its method (password,
 * provider token, lockout, account status, verification rules).
 */
export const startSession = async (
	user: User,
	device: DeviceInfo,
	options: StartSessionOptions,
): Promise<SessionTokens> => {
	const now = new Date();
	const refreshTokenId = crypto.randomUUID();
	const ttl = options.remember
		? authConfig.longSessionTtlSeconds
		: authConfig.shortSessionTtlSeconds;

	// Looked up BEFORE this sign-in is recorded, so it can only match earlier ones.
	const history = await repo().getDeviceHistory(
		user.id,
		device.deviceName,
		new Date(now.getTime() - authConfig.newDeviceWindowSeconds * 1_000),
	);

	await repo().deleteExpiredSessionsForUser(user.id);
	const session = await repo().createSession(
		buildSession(user.id, device, ttl, refreshTokenId, now),
	);
	await repo().trimSessionsForUser(user.id, authConfig.maxSessionsPerUser);

	await recordAudit({
		event: AuditEvents.SIGN_IN_SUCCESS,
		userId: user.id,
		device,
		// Core fields last: a plugin's metadata can add context but never overwrite them.
		metadata: { ...options.metadata, remember: options.remember },
	});

	// Only for confirmed addresses (an unverified one may belong to someone else), and only when
	// the account has a sign-in history, so accounts that predate the trail are not all flagged.
	if (history.hasHistory && !history.knownDevice && user.emailVerifiedAt) {
		await notifyNewDevice(user, device);
	}

	return { tokens: await issueTokens(user, session, refreshTokenId), session };
};
