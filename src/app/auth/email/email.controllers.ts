import type { Context } from "elysia";
import type { AccessTokenPayload } from "../../../packages/utils/auth";
import {
	type DeviceInfo,
	getMe,
	listSessions,
	refresh as refreshSession,
	signIn,
	signOut,
	signUp,
} from "./email.services";

const ACCESS_COOKIE = "access_token";
const REFRESH_COOKIE = "refresh_token";

const ACCESS_MAX_AGE = 15 * 60; // seconds — keep in sync with AUTH_ACCESS_TOKEN_TTL
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60; // seconds — keep in sync with AUTH_REFRESH_TOKEN_TTL

const isProd = process.env.NODE_ENV === "production";

const extractDeviceInfo = ({ headers }: Context): DeviceInfo => {
	const userAgent = headers["user-agent"] ?? "unknown";
	const ipAddress =
		headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? headers["x-real-ip"] ?? "unknown";

	return {
		deviceName: "Unknown device",
		platform: "unknown",
		browser: "unknown",
		os: "unknown",
		ipAddress,
		userAgent,
	};
};

const setAuthCookies = (
	cookie: Context["cookie"],
	tokens: { accessToken: string; refreshToken: string },
): void => {
	cookie[ACCESS_COOKIE]?.set({
		value: tokens.accessToken,
		httpOnly: true,
		secure: isProd,
		sameSite: "lax",
		path: "/",
		maxAge: ACCESS_MAX_AGE,
	});

	cookie[REFRESH_COOKIE]?.set({
		value: tokens.refreshToken,
		httpOnly: true,
		secure: isProd,
		sameSite: "lax",
		path: "/",
		maxAge: REFRESH_MAX_AGE,
	});
};

const clearAuthCookies = (cookie: Context["cookie"]): void => {
	cookie[ACCESS_COOKIE]?.remove();
	cookie[REFRESH_COOKIE]?.remove();
};

// ── POST /auth/email/signup ───────────────────────────────────────────────────

export const signUpHandler = async (context: Context) => {
	const { body, cookie, status } = context;
	const { user, tokens } = await signUp(body as never, extractDeviceInfo(context));

	setAuthCookies(cookie, tokens);

	return status(201, {
		success: true,
		message: "Sign up successful",
		user: {
			id: user.id,
			email: user.email,
			fullname: user.fullname,
			role: user.role,
		},
	});
};

// ── POST /auth/email/signin ───────────────────────────────────────────────────

export const signInHandler = async (context: Context) => {
	const { body, cookie, status } = context;
	const { user, tokens } = await signIn(body as never, extractDeviceInfo(context));

	setAuthCookies(cookie, tokens);

	return status(200, {
		success: true,
		message: "Logged in successfully",
		user: {
			id: user.id,
			email: user.email,
			fullname: user.fullname,
			role: user.role,
		},
	});
};

// ── POST /auth/email/signout ──────────────────────────────────────────────────
// Requires authenticate middleware — `user` is guaranteed to be set

export const signOutHandler = async (context: Context) => {
	const { cookie, status } = context;
	const { user } = context as unknown as { user: AccessTokenPayload };

	await signOut(user.sessionId);
	clearAuthCookies(cookie);

	return status(200, {
		success: true,
		message: "Logged out successfully",
	});
};

// ── POST /auth/email/refresh ──────────────────────────────────────────────────

export const refreshHandler = async ({ cookie, status }: Context) => {
	const token = cookie[REFRESH_COOKIE]?.value as string | undefined;

	if (!token) {
		return status(401, {
			success: false,
			message: "No refresh token provided",
		});
	}

	const tokens = await refreshSession(token);
	setAuthCookies(cookie, tokens);

	return status(200, {
		success: true,
		message: "Refreshed successfully",
	});
};

// ── GET /auth/email/me ─────────────────────────────────────────────────────────
// Requires authenticate middleware — `user` is guaranteed to be set

export const getMeHandler = async (context: Context) => {
	const { status } = context;
	const { user } = context as unknown as { user: AccessTokenPayload };
	const me = await getMe(user.userId);

	return status(200, {
		success: true,
		message: "User fetched successfully",
		user: {
			id: me.id,
			email: me.email,
			fullname: me.fullname,
			role: me.role,
			status: me.status,
		},
	});
};

// ── GET /auth/email/sessions ────────────────────────────────────────────────────
// Requires authenticate middleware — lists this user's active devices/sessions

export const listSessionsHandler = async (context: Context) => {
	const { status } = context;
	const { user } = context as unknown as { user: AccessTokenPayload };
	const sessions = await listSessions(user.userId);

	return status(200, {
		success: true,
		message: "Sessions fetched successfully",
		sessions,
	});
};
