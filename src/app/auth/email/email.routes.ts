import type { Elysia } from "elysia";

import { appConfig } from "@/packages/configs/app.config";
import { envAppConfig } from "@/packages/env/app.env";
import {
	ACCESS_COOKIE,
	authenticate,
	extractAccessToken,
} from "@/packages/middlewares/authenticate";
import {
	credentialsLimiter,
	emailActionLimiter,
	refreshLimiter,
} from "@/packages/middlewares/rate-limiter-auth";
import {
	forgotPasswordSchema,
	resendVerificationSchema,
	resetPasswordSchema,
	signInSchema,
	signUpSchema,
	verifyEmailSchema,
} from "@/packages/schema/auth.schemas";
import type { User, UserSession } from "@/packages/schema/user.schema";
import {
	clearAuthCookies,
	readRefreshToken,
	setAuthCookies,
	wantsTokensInBody,
} from "../../../packages/utils/auth-cookies";
import { extractDeviceInfo } from "../../../packages/utils/device";
import {
	forgotPassword,
	getMe,
	listSessions,
	refresh,
	resendVerification,
	resetPassword,
	signIn,
	signOut,
	signUp,
	verifyEmail,
} from "./email.services";

const route = appConfig.auth.authEmail;

const detail = (summary: string, description: string) => ({
	tags: ["Auth"],
	summary,
	description,
});

// Only these fields ever leave the API. Password hashes, lock state and token ids stay inside.
const publicUser = (user: User) => ({
	id: user.id,
	email: user.email,
	fullname: user.fullname,
	role: user.role,
	status: user.status,
});

const publicSession = (session: UserSession, currentSessionId: string) => ({
	id: session.id,
	deviceName: session.deviceName,
	platform: session.platform,
	browser: session.browser,
	os: session.os,
	ipAddress: session.ipAddress,
	lastSeenAt: session.lastSeenAt,
	createdAt: session.createdAt,
	expiresAt: session.expiresAt,
	current: session.id === currentSessionId,
});

// Mounted under the versioned API base, e.g. /api/v1/auth/email/signin.
export const registerEmailAuthRoutes = (app: Elysia): void => {
	if (!envAppConfig.ENABLE_EMAIL_AUTH) return;

	// ── Public routes ────────────────────────────────────────────────────────────
	app.group(route.path, (auth) =>
		auth
			.post(
				route.signup,
				async ({ body, cookie, request, server, status }) => {
					const { user, login } = await signUp(body, extractDeviceInfo(request, server));

					if (!login) {
						return status(201, {
							success: true,
							message:
								"Account created. Check your email to verify your address, then sign in.",
							requiresVerification: true,
							user: publicUser(user),
						});
					}

					setAuthCookies(cookie, login.tokens, login.session.expiresAt);

					return status(201, {
						success: true,
						message: "Sign up successful",
						requiresVerification: false,
						user: publicUser(user),
						...(wantsTokensInBody(request) ? { tokens: login.tokens } : {}),
					});
				},
				{
					body: signUpSchema,
					beforeHandle: credentialsLimiter,
					detail: detail(
						"Create an account",
						"Creates the account and signs the user in.",
					),
				},
			)
			.post(
				route.signin,
				async ({ body, cookie, request, server, status }) => {
					const { user, login } = await signIn(body, extractDeviceInfo(request, server));

					setAuthCookies(cookie, login.tokens, login.session.expiresAt);

					return status(200, {
						success: true,
						message: "Logged in successfully",
						user: publicUser(user),
						...(wantsTokensInBody(request) ? { tokens: login.tokens } : {}),
					});
				},
				{
					body: signInSchema,
					beforeHandle: credentialsLimiter,
					detail: detail("Sign in", "Sets httpOnly access and refresh cookies."),
				},
			)
			.post(
				route.refresh,
				async ({ body, cookie, request, status }) => {
					const token = readRefreshToken(cookie, body);

					if (!token) {
						return status(401, {
							success: false,
							message: "No refresh token provided",
						});
					}

					const { tokens, session } = await refresh(token);
					setAuthCookies(cookie, tokens, session.expiresAt);

					return status(200, {
						success: true,
						message: "Refreshed successfully",
						...(wantsTokensInBody(request) ? { tokens } : {}),
					});
				},
				{
					beforeHandle: refreshLimiter,
					detail: detail(
						"Refresh the session",
						"Rotates the refresh token. Reusing an old one revokes the session.",
					),
				},
			)
			.post(
				route.signout,
				async ({ body, cookie, headers, status }) => {
					await signOut({
						refreshToken: readRefreshToken(cookie, body),
						accessToken: extractAccessToken(
							headers.authorization,
							cookie[ACCESS_COOKIE]?.value,
						),
					});
					clearAuthCookies(cookie);

					return status(200, { success: true, message: "Logged out successfully" });
				},
				{
					detail: detail(
						"Sign out",
						"Revokes the session. Always succeeds, even with an expired token.",
					),
				},
			)
			.post(
				route.verifyEmail,
				async ({ body, status }) => {
					await verifyEmail(body);
					return status(200, { success: true, message: "Email verified" });
				},
				{
					body: verifyEmailSchema,
					beforeHandle: credentialsLimiter,
					detail: detail("Verify email", "Consumes the single-use link token."),
				},
			)
			.post(
				route.resendVerification,
				async ({ body, status }) => {
					await resendVerification(body);
					return status(202, {
						success: true,
						message: "If that address needs verification, a new link is on its way.",
					});
				},
				{
					body: resendVerificationSchema,
					beforeHandle: emailActionLimiter,
					detail: detail(
						"Resend verification email",
						"Same reply whether or not the account exists.",
					),
				},
			)
			.post(
				route.forgotPassword,
				async ({ body, status }) => {
					await forgotPassword(body);
					return status(202, {
						success: true,
						message: "If that address has an account, a reset link is on its way.",
					});
				},
				{
					body: forgotPasswordSchema,
					beforeHandle: emailActionLimiter,
					detail: detail(
						"Request a password reset",
						"Same reply whether or not the account exists.",
					),
				},
			)
			.post(
				route.resetPassword,
				async ({ body, status }) => {
					await resetPassword(body);
					return status(200, {
						success: true,
						message: "Password updated. Please sign in again.",
					});
				},
				{
					body: resetPasswordSchema,
					beforeHandle: credentialsLimiter,
					detail: detail(
						"Reset password",
						"Consumes the single-use link token and signs out every device.",
					),
				},
			),
	);

	// ── Authenticated routes ─────────────────────────────────────────────────────
	app.group(route.path, (auth) =>
		auth
			.use(authenticate)
			.get(
				route.me,
				async ({ user, status }) => {
					const me = await getMe(user.userId);
					return status(200, {
						success: true,
						message: "User fetched successfully",
						user: publicUser(me),
					});
				},
				{
					detail: detail(
						"Current user",
						"Requires a valid access cookie or Bearer token.",
					),
				},
			)
			.get(
				route.session,
				async ({ user, status }) => {
					const sessions = await listSessions(user.userId);
					return status(200, {
						success: true,
						message: "Sessions fetched successfully",
						sessions: sessions.map((session) => publicSession(session, user.sessionId)),
					});
				},
				{ detail: detail("Active sessions", "Lists this user's signed-in devices.") },
			),
	);
};
