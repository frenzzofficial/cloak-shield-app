import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

import { envAuthConfig } from "@/packages/env/auth.env";
import { AppError } from "./errors";

// ── Config ─────────────────────────────────────────────────────────────────────

const ISSUER = "cloak-shield";
const AUDIENCE = "cloak-shield-api";
const ALGORITHM = "HS256";

const encoder = new TextEncoder();
const accessKey = encoder.encode(envAuthConfig.AUTH_ACCESS_TOKEN_SECRET);
const refreshKey = encoder.encode(envAuthConfig.AUTH_REFRESH_TOKEN_SECRET);

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

// ── Token payloads ─────────────────────────────────────────────────────────────

export interface AccessTokenPayload {
	userId: string;
	email: string;
	role: string;
	sessionId: string;
}

export interface RefreshTokenPayload {
	userId: string;
	sessionId: string;
	/** Rotation id (JWT `jti`). Only the newest one per session is accepted. */
	tokenId: string;
}

// ── Sign ───────────────────────────────────────────────────────────────────────

export const signAccessToken = async (
	payload: AccessTokenPayload,
	ttlSeconds: number = envAuthConfig.AUTH_ACCESS_TOKEN_TTL,
): Promise<string> =>
	new SignJWT({ email: payload.email, role: payload.role, sid: payload.sessionId, typ: "access" })
		.setProtectedHeader({ alg: ALGORITHM })
		.setIssuer(ISSUER)
		.setAudience(AUDIENCE)
		.setSubject(payload.userId)
		.setIssuedAt()
		.setExpirationTime(nowSeconds() + ttlSeconds)
		.sign(accessKey);

/** The refresh token expires exactly when its session does (`expiresAt`), never later. */
export const signRefreshToken = async (
	payload: RefreshTokenPayload,
	expiresAt: Date,
): Promise<string> =>
	new SignJWT({ sid: payload.sessionId, typ: "refresh" })
		.setProtectedHeader({ alg: ALGORITHM })
		.setIssuer(ISSUER)
		.setAudience(AUDIENCE)
		.setSubject(payload.userId)
		.setJti(payload.tokenId)
		.setIssuedAt()
		.setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
		.sign(refreshKey);

// ── Verify ─────────────────────────────────────────────────────────────────────

export const verifyAccessToken = async (token: string): Promise<AccessTokenPayload> => {
	try {
		const { payload } = await jwtVerify(token, accessKey, {
			algorithms: [ALGORITHM],
			issuer: ISSUER,
			audience: AUDIENCE,
		});

		if (
			payload.typ !== "access" ||
			!payload.sub ||
			typeof payload.email !== "string" ||
			typeof payload.sid !== "string"
		) {
			throw AppError.unauthorized("Malformed access token");
		}

		return {
			userId: payload.sub,
			email: payload.email,
			role: typeof payload.role === "string" ? payload.role : "USER",
			sessionId: payload.sid,
		};
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw AppError.unauthorized("Invalid or expired access token");
	}
};

export const verifyRefreshToken = async (token: string): Promise<RefreshTokenPayload> => {
	try {
		const { payload } = await jwtVerify(token, refreshKey, {
			algorithms: [ALGORITHM],
			issuer: ISSUER,
			audience: AUDIENCE,
		});

		if (
			payload.typ !== "refresh" ||
			!payload.sub ||
			!payload.jti ||
			typeof payload.sid !== "string"
		) {
			throw AppError.unauthorized("Malformed refresh token");
		}

		return { userId: payload.sub, sessionId: payload.sid, tokenId: payload.jti };
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw AppError.unauthorized("Invalid or expired refresh token");
	}
};

// ── Passwords ──────────────────────────────────────────────────────────────────
// Bun's built-in argon2id: no extra dependency, and this project runs on Bun (vercel.json).

export const hashPassword = (password: string): Promise<string> =>
	Bun.password.hash(password, { algorithm: "argon2id" });

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
	Bun.password.verify(password, hash);

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same argon2 time as a real check. Sign-in calls this for unknown emails so the
 * response time does not reveal whether an account exists.
 */
export const verifyAgainstDummyHash = async (password: string): Promise<void> => {
	dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
	await verifyPassword(password, await dummyHash);
};

// ── One-time tokens (email verification, password reset) ──────────────────────

export const generateOpaqueToken = (): string => randomBytes(32).toString("base64url");

export const hashOpaqueToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");
