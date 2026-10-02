import { desc, eq, lt } from "drizzle-orm";
import type { Repository } from "../../../types/repository";
import { db } from "../../db/client";
import { userPreferences, userProfiles, userSecurity, userSessions, users } from "../../db/schema";
import type {
	User,
	UserPreferences,
	UserProfile,
	UserSecurity,
	UserSession,
} from "../../schema/user.schema";
import { AppError } from "../../utils/errors";

export class DrizzleAuthRepository implements Repository {
	// ── Core user ────────────────────────────────────────────────────────────

	async findUserByEmail(email: string): Promise<User | undefined> {
		const [row] = await db
			.select()
			.from(users)
			.where(eq(users.email, email.trim().toLowerCase()))
			.limit(1);

		return row as User | undefined;
	}

	async findUserById(id: string): Promise<User | undefined> {
		const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
		return row as User | undefined;
	}

	async createUser(user: User): Promise<User> {
		const [row] = await db
			.insert(users)
			.values({
				id: user.id,
				fullname: user.fullname,
				email: user.email,
				avatarUrl: user.avatarUrl,
				role: user.role,
				status: user.status,
				emailVerifiedAt: user.emailVerifiedAt,
			})
			.returning();

		if (!row) throw AppError.internal("createUser: insert returned no row");
		return row as User;
	}

	async updateUser(user: User): Promise<User> {
		const [row] = await db
			.update(users)
			.set({
				fullname: user.fullname,
				email: user.email,
				avatarUrl: user.avatarUrl,
				role: user.role,
				status: user.status,
				emailVerifiedAt: user.emailVerifiedAt,
				updatedAt: new Date(),
			})
			.where(eq(users.id, user.id))
			.returning();

		if (!row) throw AppError.notFound("updateUser: user not found");
		return row as User;
	}

	async deleteUser(userId: string): Promise<void> {
		await db.delete(users).where(eq(users.id, userId));
	}

	async getAllUsers(
		args: { limit?: number; cursor?: string } = {},
	): Promise<{ users: User[]; nextCursor: string | undefined }> {
		const limit = args.limit ?? 20;

		const rows = await db
			.select()
			.from(users)
			.where(args.cursor ? lt(users.createdAt, new Date(args.cursor)) : undefined)
			.orderBy(desc(users.createdAt))
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const page = hasMore ? rows.slice(0, limit) : rows;
		const last = page[page.length - 1];

		return {
			users: page as User[],
			nextCursor: hasMore && last ? last.createdAt.toISOString() : undefined,
		};
	}

	// ── Security ─────────────────────────────────────────────────────────────

	async getUserSecurity(userId: string): Promise<UserSecurity | undefined> {
		const [row] = await db
			.select()
			.from(userSecurity)
			.where(eq(userSecurity.userId, userId))
			.limit(1);

		return row as UserSecurity | undefined;
	}

	async createUserSecurity(security: UserSecurity): Promise<UserSecurity> {
		const [row] = await db
			.insert(userSecurity)
			.values({
				userId: security.userId,
				passwordHash: security.passwordHash,
				twoFactorEnabled: security.twoFactorEnabled,
				failedLoginAttempts: security.failedLoginAttempts,
				lockedUntil: security.lockedUntil,
				lastPasswordChangedAt: security.lastPasswordChangedAt,
			})
			.returning();

		if (!row) throw AppError.internal("createUserSecurity: insert returned no row");
		return row as UserSecurity;
	}

	async updateUserSecurity(
		userId: string,
		patch: Partial<Omit<UserSecurity, "userId">>,
	): Promise<UserSecurity> {
		const [row] = await db
			.update(userSecurity)
			.set({ ...patch, updatedAt: new Date() })
			.where(eq(userSecurity.userId, userId))
			.returning();

		if (!row) throw AppError.notFound("updateUserSecurity: record not found");
		return row as UserSecurity;
	}

	// ── Profile ──────────────────────────────────────────────────────────────

	async getUserProfile(userId: string): Promise<UserProfile | undefined> {
		const [row] = await db
			.select()
			.from(userProfiles)
			.where(eq(userProfiles.userId, userId))
			.limit(1);
		return row as UserProfile | undefined;
	}

	async createUserProfile(profile: UserProfile): Promise<UserProfile> {
		const [row] = await db
			.insert(userProfiles)
			.values({
				userId: profile.userId,
				username: profile.username,
				bio: profile.bio,
				phone: profile.phone,
				birthDate: profile.birthDate,
				gender: profile.gender,
				timezone: profile.timezone,
				locale: profile.locale,
				website: profile.website,
				twitterUrl: profile.twitterUrl,
				githubUrl: profile.githubUrl,
				linkedinUrl: profile.linkedinUrl,
			})
			.returning();

		if (!row) throw AppError.internal("createUserProfile: insert returned no row");
		return row as UserProfile;
	}

	async updateUserProfile(
		userId: string,
		patch: Partial<Omit<UserProfile, "userId">>,
	): Promise<UserProfile> {
		const [row] = await db
			.update(userProfiles)
			.set({ ...patch, updatedAt: new Date() })
			.where(eq(userProfiles.userId, userId))
			.returning();

		if (!row) throw AppError.notFound("updateUserProfile: record not found");
		return row as UserProfile;
	}

	// ── Preferences ──────────────────────────────────────────────────────────

	async getUserPreferences(userId: string): Promise<UserPreferences | undefined> {
		const [row] = await db
			.select()
			.from(userPreferences)
			.where(eq(userPreferences.userId, userId))
			.limit(1);

		return row as UserPreferences | undefined;
	}

	async createUserPreferences(preferences: UserPreferences): Promise<UserPreferences> {
		const [row] = await db
			.insert(userPreferences)
			.values({
				userId: preferences.userId,
				theme: preferences.theme,
				language: preferences.language,
				emailNotifications: preferences.emailNotifications,
				pushNotifications: preferences.pushNotifications,
				marketingEmails: preferences.marketingEmails,
				reducedMotion: preferences.reducedMotion,
				highContrast: preferences.highContrast,
			})
			.returning();

		if (!row) throw AppError.internal("createUserPreferences: insert returned no row");
		return row as UserPreferences;
	}

	async updateUserPreferences(
		userId: string,
		patch: Partial<Omit<UserPreferences, "userId">>,
	): Promise<UserPreferences> {
		const [row] = await db
			.update(userPreferences)
			.set({ ...patch, updatedAt: new Date() })
			.where(eq(userPreferences.userId, userId))
			.returning();

		if (!row) throw AppError.notFound("updateUserPreferences: record not found");
		return row as UserPreferences;
	}

	// ── Sessions ─────────────────────────────────────────────────────────────

	async createSession(session: UserSession): Promise<UserSession> {
		const [row] = await db
			.insert(userSessions)
			.values({
				id: session.id,
				userId: session.userId,
				deviceName: session.deviceName,
				platform: session.platform,
				browser: session.browser,
				os: session.os,
				ipAddress: session.ipAddress,
				userAgent: session.userAgent,
				lastSeenAt: session.lastSeenAt,
				expiresAt: session.expiresAt,
			})
			.returning();

		if (!row) throw AppError.internal("createSession: insert returned no row");
		return row as UserSession;
	}

	async getSession(id: string): Promise<UserSession | undefined> {
		const [row] = await db.select().from(userSessions).where(eq(userSessions.id, id)).limit(1);
		return row as UserSession | undefined;
	}

	async revokeSession(id: string): Promise<void> {
		await db.delete(userSessions).where(eq(userSessions.id, id));
	}

	async deleteSessionsForUser(userId: string): Promise<void> {
		await db.delete(userSessions).where(eq(userSessions.userId, userId));
	}

	async listSessionsForUser(userId: string): Promise<UserSession[]> {
		const rows = await db
			.select()
			.from(userSessions)
			.where(eq(userSessions.userId, userId))
			.orderBy(desc(userSessions.lastSeenAt));

		return rows as UserSession[];
	}

	// ── Transactional registration ──────────────────────────────────────────
	// A real Postgres transaction now (Drizzle's `db.transaction`) — unlike the
	// old supabase-js version, this rolls back atomically on any failure
	// instead of manually deleting the user afterward.

	async createUserWithSession(args: {
		user: User;
		profile: UserProfile;
		security: UserSecurity;
		preferences: UserPreferences;
		session: UserSession;
	}): Promise<User> {
		return db.transaction(async (tx) => {
			const [createdUser] = await tx
				.insert(users)
				.values({
					id: args.user.id,
					fullname: args.user.fullname,
					email: args.user.email,
					avatarUrl: args.user.avatarUrl,
					role: args.user.role,
					status: args.user.status,
					emailVerifiedAt: args.user.emailVerifiedAt,
				})
				.returning();

			if (!createdUser) throw AppError.internal("createUserWithSession: user insert failed");

			await tx.insert(userSecurity).values({
				userId: createdUser.id,
				passwordHash: args.security.passwordHash,
				twoFactorEnabled: args.security.twoFactorEnabled,
				failedLoginAttempts: args.security.failedLoginAttempts,
				lockedUntil: args.security.lockedUntil,
				lastPasswordChangedAt: args.security.lastPasswordChangedAt,
			});

			await tx.insert(userProfiles).values({
				userId: createdUser.id,
				username: args.profile.username,
				bio: args.profile.bio,
				phone: args.profile.phone,
				birthDate: args.profile.birthDate,
				gender: args.profile.gender,
				timezone: args.profile.timezone,
				locale: args.profile.locale,
				website: args.profile.website,
				twitterUrl: args.profile.twitterUrl,
				githubUrl: args.profile.githubUrl,
				linkedinUrl: args.profile.linkedinUrl,
			});

			await tx.insert(userPreferences).values({
				userId: createdUser.id,
				theme: args.preferences.theme,
				language: args.preferences.language,
				emailNotifications: args.preferences.emailNotifications,
				pushNotifications: args.preferences.pushNotifications,
				marketingEmails: args.preferences.marketingEmails,
				reducedMotion: args.preferences.reducedMotion,
				highContrast: args.preferences.highContrast,
			});

			await tx.insert(userSessions).values({
				id: args.session.id,
				userId: createdUser.id,
				deviceName: args.session.deviceName,
				platform: args.session.platform,
				browser: args.session.browser,
				os: args.session.os,
				ipAddress: args.session.ipAddress,
				userAgent: args.session.userAgent,
				lastSeenAt: args.session.lastSeenAt,
				expiresAt: args.session.expiresAt,
			});

			return createdUser as User;
		});
	}
}

let cached: DrizzleAuthRepository | null = null;

export const getAuthRepository = (): DrizzleAuthRepository => {
	if (!cached) cached = new DrizzleAuthRepository();
	return cached;
};
