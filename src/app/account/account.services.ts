import { recordAudit } from "@/app/auth/core/audit.service";
import type { DeviceInfo } from "@/app/auth/core/auth.types";
import { notifyAccountDeleted } from "@/app/auth/core/auth-mail";
import { type AuthContext, requirePassword } from "@/app/auth/core/reauth";
import { AuditEvents } from "@/packages/configs/audit.config";
import { getAuthRepository } from "@/packages/repository/drizzle/auth.repository";
import type { UpdatePreferencesBody, UpdateProfileBody } from "@/packages/schema/account.schemas";
import type { User, UserPreferences, UserProfile } from "@/packages/schema/user.schema";
import { isUniqueViolation } from "@/packages/utils/db-errors";
import { AppError } from "@/packages/utils/errors";

const repo = () => getAuthRepository();

export interface Account {
	user: User;
	profile: UserProfile;
	preferences: UserPreferences;
}

export const getAccount = async (userId: string): Promise<Account> => {
	const [user, profile, preferences] = await Promise.all([
		repo().findUserById(userId),
		repo().getUserProfile(userId),
		repo().getUserPreferences(userId),
	]);

	if (!user || !profile || !preferences) throw AppError.notFound("Account not found");
	return { user, profile, preferences };
};

// PATCH semantics: a field that is absent is left alone, null clears it. Built field by field
// (rather than spreading the request) so an absent key can never overwrite a value with undefined.
const profilePatchFrom = (body: UpdateProfileBody): Partial<Omit<UserProfile, "userId">> => {
	const patch: Partial<Omit<UserProfile, "userId">> = {};

	if (body.username !== undefined) patch.username = body.username;
	if (body.bio !== undefined) patch.bio = body.bio;
	if (body.phone !== undefined) patch.phone = body.phone;
	if (body.birthDate !== undefined) {
		patch.birthDate =
			body.birthDate === null ? null : new Date(`${body.birthDate}T00:00:00.000Z`);
	}
	if (body.gender !== undefined) patch.gender = body.gender;
	if (body.timezone !== undefined) patch.timezone = body.timezone;
	if (body.locale !== undefined) patch.locale = body.locale;
	if (body.website !== undefined) patch.website = body.website;
	if (body.twitterUrl !== undefined) patch.twitterUrl = body.twitterUrl;
	if (body.githubUrl !== undefined) patch.githubUrl = body.githubUrl;
	if (body.linkedinUrl !== undefined) patch.linkedinUrl = body.linkedinUrl;

	return patch;
};

export const updateProfile = async (
	userId: string,
	body: UpdateProfileBody,
	device: DeviceInfo,
): Promise<Account> => {
	const current = await getAccount(userId);
	const patch = profilePatchFrom(body);

	try {
		if (body.fullname !== undefined || body.avatarUrl !== undefined) {
			await repo().updateUser({
				...current.user,
				fullname: body.fullname ?? current.user.fullname,
				avatarUrl: body.avatarUrl === undefined ? current.user.avatarUrl : body.avatarUrl,
			});
		}

		if (Object.keys(patch).length > 0) {
			await repo().updateUserProfile(userId, patch);
		}
	} catch (error) {
		if (isUniqueViolation(error)) throw AppError.conflict("That username is already taken");
		throw error;
	}

	// Field NAMES only: the values (phone, birth date, ...) do not belong in the audit trail.
	await recordAudit({
		event: AuditEvents.PROFILE_UPDATED,
		userId,
		device,
		metadata: { fields: Object.keys(body) },
	});

	return getAccount(userId);
};

export const updatePreferences = async (
	userId: string,
	body: UpdatePreferencesBody,
	device: DeviceInfo,
): Promise<UserPreferences> => {
	const patch: Partial<Omit<UserPreferences, "userId">> = {};

	if (body.theme !== undefined) patch.theme = body.theme;
	if (body.language !== undefined) patch.language = body.language;
	if (body.emailNotifications !== undefined) patch.emailNotifications = body.emailNotifications;
	if (body.pushNotifications !== undefined) patch.pushNotifications = body.pushNotifications;
	if (body.marketingEmails !== undefined) patch.marketingEmails = body.marketingEmails;
	if (body.reducedMotion !== undefined) patch.reducedMotion = body.reducedMotion;
	if (body.highContrast !== undefined) patch.highContrast = body.highContrast;

	const updated = await repo().updateUserPreferences(userId, patch);

	await recordAudit({
		event: AuditEvents.PREFERENCES_UPDATED,
		userId,
		device,
		metadata: { fields: Object.keys(body) },
	});

	return updated;
};

/**
 * Permanent. Cascades to the profile, preferences, security row, sessions and tokens. Audit rows
 * stay, detached from the account (user_id becomes NULL), so the history survives without
 * keeping personal data.
 */
export const deleteAccount = async (
	auth: AuthContext,
	password: string,
	device: DeviceInfo,
): Promise<void> => {
	const user = await requirePassword(auth.userId, password, device, "delete_account");

	// Recorded first: afterwards there is no account left to attach it to.
	await recordAudit({ event: AuditEvents.ACCOUNT_DELETED, userId: user.id, device });
	await repo().deleteUser(user.id);

	await notifyAccountDeleted(user.email);
};
