import { jwtVerify, SignJWT } from "jose";

import { AppError } from "./errors";

// ── Config ───────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_SECRET = process.env.AUTH_ACCESS_TOKEN_SECRET ?? "";
const REFRESH_TOKEN_SECRET = process.env.AUTH_REFRESH_TOKEN_SECRET ?? "";

const ACCESS_TOKEN_TTL = process.env.AUTH_ACCESS_TOKEN_TTL ?? "15m";
const REFRESH_TOKEN_TTL = process.env.AUTH_REFRESH_TOKEN_TTL ?? "30d";

const getSecretKey = (secret: string, name: string): Uint8Array => {
	if (!secret) {
		throw new Error(`Missing ${name} environment variable.`);
	}
	return new TextEncoder().encode(secret);
};

// ── Token payloads ───────────────────────────────────────────────────────────

export interface AccessTokenPayload {
	userId: string;
	email: string;
	role: string;
	sessionId: string;
}

export interface RefreshTokenPayload {
	userId: string;
	sessionId: string;
}

// ── Sign ─────────────────────────────────────────────────────────────────────

export const signAccessToken = async (payload: AccessTokenPayload): Promise<string> => {
	const key = getSecretKey(ACCESS_TOKEN_SECRET, "AUTH_ACCESS_TOKEN_SECRET");

	return new SignJWT({
		email: payload.email,
		role: payload.role,
		sid: payload.sessionId,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(payload.userId)
		.setIssuedAt()
		.setExpirationTime(ACCESS_TOKEN_TTL)
		.sign(key);
};

export const signRefreshToken = async (payload: RefreshTokenPayload): Promise<string> => {
	const key = getSecretKey(REFRESH_TOKEN_SECRET, "AUTH_REFRESH_TOKEN_SECRET");

	return new SignJWT({ sid: payload.sessionId })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(payload.userId)
		.setIssuedAt()
		.setExpirationTime(REFRESH_TOKEN_TTL)
		.sign(key);
};

// ── Verify ───────────────────────────────────────────────────────────────────

export const verifyAccessToken = async (token: string): Promise<AccessTokenPayload> => {
	const key = getSecretKey(ACCESS_TOKEN_SECRET, "AUTH_ACCESS_TOKEN_SECRET");

	try {
		const { payload } = await jwtVerify(token, key);

		if (!payload.sub || typeof payload.email !== "string" || typeof payload.sid !== "string") {
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
	const key = getSecretKey(REFRESH_TOKEN_SECRET, "AUTH_REFRESH_TOKEN_SECRET");

	try {
		const { payload } = await jwtVerify(token, key);

		if (!payload.sub || typeof payload.sid !== "string") {
			throw AppError.unauthorized("Malformed refresh token");
		}

		return {
			userId: payload.sub,
			sessionId: payload.sid,
		};
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw AppError.unauthorized("Invalid or expired refresh token");
	}
};

// ── Passwords ────────────────────────────────────────────────────────────────
// Uses Bun's built-in password hashing (argon2id) — no extra dependency, and
// this project is deployed on the Bun runtime (see vercel.json).

export const hashPassword = (password: string): Promise<string> =>
	Bun.password.hash(password, { algorithm: "argon2id" });

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
	Bun.password.verify(password, hash);
