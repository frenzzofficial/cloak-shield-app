import { z } from "zod";
import type { AuditEvent, AuditOutcome } from "../configs/audit.config";
import type { AuthTokenType } from "../configs/auth-token.config";
import { UserGenderValues } from "../configs/gender.config";
import type { OAuthProvider } from "../configs/oauth-provider.config";
import { UserRolesValues, userStatusValues } from "../configs/roles.config";
import {
	confirmPasswordRules,
	emailRules,
	fullnameRules,
	passwordRules,
	phoneRules,
	schemaMessages,
	usernameRules,
} from "../configs/schemas.config";

export const userSchema = z.object({
	id: z.uuid(),
	// Optional at sign-up, so "no name yet" is null rather than an empty string.
	fullname: fullnameRules.nullable(),
	email: emailRules,
	avatarUrl: z.url().nullable(),
	role: z.enum(UserRolesValues),
	status: z.enum(userStatusValues),
	emailVerifiedAt: z.coerce.date().nullable(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});

export type User = z.infer<typeof userSchema>;

export const userProfileSchema = z.object({
	userId: z.uuid(),
	username: usernameRules.nullable(),
	bio: z.string().max(500).nullable(),
	phone: phoneRules.nullable(),
	birthDate: z.coerce.date().nullable(),
	gender: z.enum(UserGenderValues).nullable(),
	timezone: z.string().nullable(),
	locale: z.string().nullable(),
	website: z.url().nullable(),
	twitterUrl: z.url().nullable(),
	githubUrl: z.url().nullable(),
	linkedinUrl: z.url().nullable(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});

export type UserProfile = z.infer<typeof userProfileSchema>;

export const userSecuritySchema = z.object({
	userId: z.uuid(),
	// null for accounts that only sign in through a provider
	passwordHash: z.string().nullable(),
	twoFactorEnabled: z.boolean(),
	failedLoginAttempts: z.number().int().nonnegative(),
	lockedUntil: z.coerce.date().nullable(),
	lastPasswordChangedAt: z.coerce.date().nullable(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});

export type UserSecurity = z.infer<typeof userSecuritySchema>;

export const userSessionSchema = z.object({
	id: z.uuid(),
	userId: z.uuid(),
	deviceName: z.string(),
	platform: z.string(),
	browser: z.string(),
	os: z.string(),
	ipAddress: z.string(),
	userAgent: z.string(),
	refreshTokenId: z.string(),
	previousRefreshTokenId: z.string().nullable(),
	refreshRotatedAt: z.coerce.date().nullable(),
	lastSeenAt: z.coerce.date(),
	expiresAt: z.coerce.date(),
	createdAt: z.coerce.date(),
});

export type UserSession = z.infer<typeof userSessionSchema>;

/** Single-use email-verification / password-reset token (hash only, never the raw token). */
export interface AuthTokenRecord {
	id: string;
	userId: string;
	type: AuthTokenType;
	tokenHash: string;
	/** EMAIL_CHANGE only: the address the link switches the account to. */
	newEmail: string | null;
	expiresAt: Date;
	usedAt: Date | null;
	createdAt: Date;
}

/** A provider identity linked to an account. Deliberately holds no provider tokens. */
export interface OAuthAccountRecord {
	id: string;
	userId: string;
	provider: OAuthProvider;
	/** The provider's stable subject id (Google `sub`, Discord user id), never the email. */
	providerUserId: string;
	createdAt: Date;
	lastLoginAt: Date;
}

/** One row of the security audit trail. */
export interface AuditLogRecord {
	id: string;
	userId: string | null;
	subjectId: string | null;
	event: AuditEvent;
	outcome: AuditOutcome;
	ipAddress: string;
	userAgent: string;
	metadata: Record<string, unknown>;
	createdAt: Date;
}

export const userPreferencesSchema = z.object({
	userId: z.uuid(),
	theme: z.enum(["light", "dark", "system"]),
	language: z.string(),
	emailNotifications: z.boolean(),
	pushNotifications: z.boolean(),
	marketingEmails: z.boolean(),
	reducedMotion: z.boolean(),
	highContrast: z.boolean(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

/** Editable subset — a profile form only ever touches these two fields. */
export const updateProfileSchema = z.object({
	fullname: fullnameRules,
	email: emailRules,
	phone: phoneRules,
	avatarUrl: z.url().nullable().optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z
	.object({
		currentPassword: z.string().trim().min(1, schemaMessages.passwordRequired),
		newPassword: passwordRules,
		confirmPassword: confirmPasswordRules,
	})
	.refine((data) => data.newPassword === data.confirmPassword, {
		message: schemaMessages.passwordMismatch,
		path: ["confirmPassword"],
	})
	.refine((data) => data.currentPassword !== data.newPassword, {
		message: "New password must be different from the current password",
		path: ["newPassword"],
	});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
