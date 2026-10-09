import type { AuthTokenType } from "../../../packages/configs/auth-token.config";
import { getAuthRepository } from "../../../packages/repository/drizzle/auth.repository";
import { generateOpaqueToken, hashOpaqueToken } from "../../../packages/utils/auth";

/**
 * Creates a single-use link token and returns the raw value (to put in the email). Only its
 * SHA-256 hash is stored. Requesting another one of the same kind invalidates the previous,
 * so only the newest link works.
 */
export const issueEmailToken = async (
	userId: string,
	type: AuthTokenType,
	ttlSeconds: number,
	newEmail: string | null = null,
): Promise<string> => {
	const repo = getAuthRepository();
	await repo.deleteAuthTokensForUser(userId, type);

	const token = generateOpaqueToken();
	const now = new Date();

	await repo.createAuthToken({
		id: crypto.randomUUID(),
		userId,
		type,
		tokenHash: hashOpaqueToken(token),
		newEmail,
		expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
		usedAt: null,
		createdAt: now,
	});

	return token;
};
