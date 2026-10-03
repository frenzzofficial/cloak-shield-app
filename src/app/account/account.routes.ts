import type { Elysia } from "elysia";

import { appConfig } from "@/packages/configs/app.config";
import { envAppConfig } from "@/packages/env/app.env";
import { authenticate } from "@/packages/middlewares/authenticate";
import { accountActionLimiter } from "@/packages/middlewares/rate-limiter-auth";
import {
	updatePreferencesBodySchema,
	updateProfileBodySchema,
} from "@/packages/schema/account.schemas";
import { deleteAccountSchema } from "@/packages/schema/auth.schemas";
import type { UserPreferences, UserProfile } from "@/packages/schema/user.schema";
import { clearAuthCookies } from "../auth/auth-cookies";
import { extractDeviceInfo } from "../auth/device";
import {
	type Account,
	deleteAccount,
	getAccount,
	updatePreferences,
	updateProfile,
} from "./account.services";

const route = appConfig.account;

const detail = (summary: string, description: string) => ({
	tags: ["Account"],
	summary,
	description,
});

const publicProfile = (profile: UserProfile) => ({
	username: profile.username,
	bio: profile.bio,
	phone: profile.phone,
	birthDate: profile.birthDate ? profile.birthDate.toISOString().slice(0, 10) : null,
	gender: profile.gender,
	timezone: profile.timezone,
	locale: profile.locale,
	website: profile.website,
	twitterUrl: profile.twitterUrl,
	githubUrl: profile.githubUrl,
	linkedinUrl: profile.linkedinUrl,
});

const publicPreferences = (preferences: UserPreferences) => ({
	theme: preferences.theme,
	language: preferences.language,
	emailNotifications: preferences.emailNotifications,
	pushNotifications: preferences.pushNotifications,
	marketingEmails: preferences.marketingEmails,
	reducedMotion: preferences.reducedMotion,
	highContrast: preferences.highContrast,
});

const publicAccount = ({ user, profile, preferences }: Account) => ({
	user: {
		id: user.id,
		email: user.email,
		fullname: user.fullname,
		avatarUrl: user.avatarUrl,
		role: user.role,
		status: user.status,
		emailVerifiedAt: user.emailVerifiedAt,
		createdAt: user.createdAt,
	},
	profile: publicProfile(profile),
	preferences: publicPreferences(preferences),
});

// Mounted at e.g. /api/v1/account/profile. Everything here needs a signed-in user.
export const registerAccountRoutes = (app: Elysia): void => {
	if (!envAppConfig.ENABLE_EMAIL_AUTH) return;

	app.group(route.path, (account) =>
		account
			.use(authenticate)
			.get(
				route.profile,
				async ({ user, status }) =>
					status(200, { success: true, ...publicAccount(await getAccount(user.userId)) }),
				{ detail: detail("Get profile", "The account, its profile and preferences.") },
			)
			.patch(
				route.profile,
				async ({ user, body, request, server, status }) => {
					const account = await updateProfile(
						user.userId,
						body,
						extractDeviceInfo(request, server),
					);
					return status(200, { success: true, ...publicAccount(account) });
				},
				{
					body: updateProfileBodySchema,
					beforeHandle: accountActionLimiter,
					detail: detail(
						"Update profile",
						"Send only the fields to change; null clears one. Email changes go through /auth/email/change-email.",
					),
				},
			)
			.patch(
				route.preferences,
				async ({ user, body, request, server, status }) => {
					const preferences = await updatePreferences(
						user.userId,
						body,
						extractDeviceInfo(request, server),
					);
					return status(200, {
						success: true,
						preferences: publicPreferences(preferences),
					});
				},
				{
					body: updatePreferencesBodySchema,
					beforeHandle: accountActionLimiter,
					detail: detail("Update preferences", "Send only the fields to change."),
				},
			)
			.post(
				route.delete,
				async ({ user, body, cookie, request, server, status }) => {
					await deleteAccount(user, body.password, extractDeviceInfo(request, server));
					clearAuthCookies(cookie);
					return status(200, { success: true, message: "Your account was deleted" });
				},
				{
					body: deleteAccountSchema,
					beforeHandle: accountActionLimiter,
					detail: detail(
						"Delete account",
						"Permanent. Needs the current password; removes the account and all of its data.",
					),
				},
			),
	);
};
