import type { Elysia } from "elysia";
import type { AuthCore } from "@/app/auth/core/plugin";
import { appConfig } from "@/packages/configs/app.config";
import {
	ACCESS_COOKIE,
	authenticate,
	extractAccessToken,
} from "@/packages/middlewares/authenticate";
import {
	accountActionLimiter,
	credentialsLimiter,
	emailActionLimiter,
	refreshLimiter,
} from "@/packages/middlewares/rate-limiter-auth";
import {
	activityQuerySchema,
	changeEmailSchema,
	changePasswordBodySchema,
	confirmEmailChangeSchema,
	forgotPasswordSchema,
	resendVerificationSchema,
	resetPasswordSchema,
	sessionParamsSchema,
	signInSchema,
	signUpSchema,
	verifyEmailSchema,
} from "@/packages/schema/auth.schemas";
import type { AuditLogRecord, User, UserSession } from "@/packages/schema/user.schema";
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
import {
	changeEmail,
	changePassword,
	confirmEmailChange,
	listActivity,
	revokeOtherSessions,
	revokeSession,
} from "./security.services";

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

const deviceNameOf = (entry: AuditLogRecord): string | null =>
	typeof entry.metadata.deviceName === "string" ? entry.metadata.deviceName : null;

// What a user sees of their own security history: what happened, when, from where. Internal
// metadata (keyed hashes, failure reasons, session ids) stays server-side.
const publicActivity = (entry: AuditLogRecord) => ({
	id: entry.id,
	event: entry.event,
	outcome: entry.outcome,
	deviceName: deviceNameOf(entry),
	ipAddress: entry.ipAddress,
	createdAt: entry.createdAt,
});

// Mounted under the versioned API base, e.g. /api/v1/auth/email/signin.
export const registerEmailAuthRoutes = (app: Elysia, core: AuthCore): void => {
	const { cookies, device } = core;

	// ── Public routes ────────────────────────────────────────────────────────────
	app.group(route.path, (auth) =>
		auth
			.post(
				route.signup,
				async ({ body, cookie, request, server, status }) => {
					const { user, login } = await signUp(body, device.extract(request, server));

					if (!login) {
						return status(201, {
							success: true,
							message:
								"Account created. Check your email to verify your address, then sign in.",
							requiresVerification: true,
							user: publicUser(user),
						});
					}

					cookies.set(cookie, login.tokens, login.session.expiresAt);

					return status(201, {
						success: true,
						message: "Sign up successful",
						requiresVerification: false,
						user: publicUser(user),
						...(cookies.wantsTokensInBody(request) ? { tokens: login.tokens } : {}),
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
					const { user, login } = await signIn(body, device.extract(request, server));

					cookies.set(cookie, login.tokens, login.session.expiresAt);

					return status(200, {
						success: true,
						message: "Logged in successfully",
						user: publicUser(user),
						...(cookies.wantsTokensInBody(request) ? { tokens: login.tokens } : {}),
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
				async ({ body, cookie, request, server, status }) => {
					const token = cookies.readRefreshToken(cookie, body);

					if (!token) {
						return status(401, {
							success: false,
							message: "No refresh token provided",
						});
					}

					const { tokens, session } = await refresh(
						token,
						device.extract(request, server),
					);
					cookies.set(cookie, tokens, session.expiresAt);

					return status(200, {
						success: true,
						message: "Refreshed successfully",
						...(cookies.wantsTokensInBody(request) ? { tokens } : {}),
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
				async ({ body, cookie, headers, request, server, status }) => {
					await signOut(
						{
							refreshToken: cookies.readRefreshToken(cookie, body),
							accessToken: extractAccessToken(
								headers.authorization,
								cookie[ACCESS_COOKIE]?.value,
							),
						},
						device.extract(request, server),
					);
					cookies.clear(cookie);

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
				async ({ body, request, server, status }) => {
					await verifyEmail(body, device.extract(request, server));
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
				async ({ body, request, server, status }) => {
					await forgotPassword(body, device.extract(request, server));
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
				async ({ body, request, server, status }) => {
					await resetPassword(body, device.extract(request, server));
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
			)
			.post(
				route.confirmEmailChange,
				async ({ body, cookie, request, server, status }) => {
					await confirmEmailChange(body, device.extract(request, server));
					// Every session of the account was ended; drop this browser's cookies too.
					cookies.clear(cookie);
					return status(200, {
						success: true,
						message: "Email address updated. Please sign in with the new address.",
					});
				},
				{
					body: confirmEmailChangeSchema,
					beforeHandle: credentialsLimiter,
					detail: detail(
						"Confirm an email change",
						"Consumes the single-use link sent to the NEW address and signs out every device.",
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
					const { user: me, hasPassword } = await getMe(user.userId);
					return status(200, {
						success: true,
						message: "User fetched successfully",
						// hasPassword tells a frontend whether to offer "change" or "set" password.
						user: { ...publicUser(me), hasPassword },
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
			)
			.post(
				route.revokeOtherSessions,
				async ({ user, request, server, status }) => {
					const { revokedSessions } = await revokeOtherSessions(
						user,
						device.extract(request, server),
					);
					return status(200, {
						success: true,
						message: "Signed out of your other devices",
						revokedSessions,
					});
				},
				{
					beforeHandle: accountActionLimiter,
					detail: detail(
						"Sign out everywhere else",
						"Keeps this device, ends every other session.",
					),
				},
			)
			.delete(
				route.sessionById,
				async ({ user, params, cookie, request, server, status }) => {
					const { revokedCurrent } = await revokeSession(
						user,
						params.id,
						device.extract(request, server),
					);
					if (revokedCurrent) cookies.clear(cookie);
					return status(200, { success: true, message: "Session revoked" });
				},
				{
					params: sessionParamsSchema,
					beforeHandle: accountActionLimiter,
					detail: detail("Revoke one session", "Signs one of the user's devices out."),
				},
			)
			.post(
				route.changePassword,
				async ({ user, body, request, server, status }) => {
					const { revokedSessions, wasSet } = await changePassword(
						user,
						body,
						device.extract(request, server),
					);
					return status(200, {
						success: true,
						message: wasSet
							? "Password set. You can now sign in with your email and password too."
							: "Password changed. Your other devices were signed out.",
						revokedSessions,
					});
				},
				{
					body: changePasswordBodySchema,
					beforeHandle: accountActionLimiter,
					detail: detail(
						"Change password",
						"Needs the current password (accounts without one use a recent sign-in instead, and this sets their first). Ends every other session and emails a notice.",
					),
				},
			)
			.post(
				route.changeEmail,
				async ({ user, body, request, server, status }) => {
					await changeEmail(user, body, device.extract(request, server));
					return status(202, {
						success: true,
						message:
							"Check the new address for a confirmation link. Nothing changes until you open it.",
					});
				},
				{
					body: changeEmailSchema,
					beforeHandle: accountActionLimiter,
					detail: detail(
						"Request an email change",
						"Needs the current password. Sends a link to the new address and a notice to the old one.",
					),
				},
			)
			.get(
				route.activity,
				async ({ user, query, status }) => {
					const entries = await listActivity(user.userId, query);
					const oldest = entries[entries.length - 1];

					return status(200, {
						success: true,
						message: "Activity fetched successfully",
						activity: entries.map(publicActivity),
						// Pass this back as ?before= to page further into the past.
						nextBefore:
							entries.length === query.limit && oldest ? oldest.createdAt : null,
					});
				},
				{
					query: activityQuerySchema,
					detail: detail(
						"Security activity",
						"The signed-in user's own security event history.",
					),
				},
			),
	);
};
