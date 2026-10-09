import type {
	UserPreferences,
	UserProfile,
	UserSecurity,
} from "../../../packages/schema/user.schema";

// What a brand-new account starts with, whichever way it was created (email form or a provider).
// `userId` is "" on purpose: createUserWithSession fills in the real id inside its transaction.

export const newProfile = (now: Date): UserProfile => ({
	userId: "",
	username: null,
	bio: null,
	phone: null,
	birthDate: null,
	gender: null,
	timezone: null,
	locale: null,
	website: null,
	twitterUrl: null,
	githubUrl: null,
	linkedinUrl: null,
	createdAt: now,
	updatedAt: now,
});

export const newPreferences = (now: Date): UserPreferences => ({
	userId: "",
	theme: "system",
	language: "en",
	emailNotifications: true,
	pushNotifications: true,
	marketingEmails: false,
	reducedMotion: false,
	highContrast: false,
	createdAt: now,
	updatedAt: now,
});

/** `passwordHash` is null for accounts that only ever sign in through a provider. */
export const newSecurity = (passwordHash: string | null, now: Date): UserSecurity => ({
	userId: "",
	passwordHash,
	twoFactorEnabled: false,
	failedLoginAttempts: 0,
	lockedUntil: null,
	lastPasswordChangedAt: now,
	createdAt: now,
	updatedAt: now,
});
