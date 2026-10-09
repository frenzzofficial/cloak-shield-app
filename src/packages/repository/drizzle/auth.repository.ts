import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { AuditEvents } from "@/packages/configs/audit.config";
import type { AuthTokenType } from "@/packages/configs/auth-token.config";
import type { OAuthProvider } from "@/packages/configs/oauth-provider.config";
import { db } from "@/packages/db/client";
import {
	auditLogs,
	authTokens,
	oauthAccounts,
	userPreferences,
	userProfiles,
	userSecurity,
	userSessions,
	users,
} from "@/packages/db/schema";
import type {
	AuditLogRecord,
	AuthTokenRecord,
	OAuthAccountRecord,
	User,
	UserPreferences,
	UserProfile,
	UserSecurity,
	UserSession,
} from "@/packages/schema/user.schema";
import { AppError } from "@/packages/utils/errors";
import type { Repository } from "@/types/repository";

class DrizzleAuthRepository implements Repository {
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
				email: user.email.trim().toLowerCase(),
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
				email: user.email.trim().toLowerCase(),
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

	async registerFailedLogin(
		userId: string,
		maxAttempts: number,
		lockSeconds: number,
	): Promise<UserSecurity | undefined> {
		// One UPDATE, so concurrent wrong guesses each increment the same counter instead of all
		// reading "0" and writing "1". Postgres evaluates every SET expression against the OLD
		// row, which is why the next-count expression is spelled out twice.
		const lockExpired = sql`(${userSecurity.lockedUntil} IS NOT NULL AND ${userSecurity.lockedUntil} <= now())`;
		const nextCount = sql`(CASE WHEN ${lockExpired} THEN 1 ELSE ${userSecurity.failedLoginAttempts} + 1 END)`;

		const [row] = await db
			.update(userSecurity)
			.set({
				failedLoginAttempts: nextCount,
				lockedUntil: sql`(CASE WHEN ${nextCount} >= ${maxAttempts}::int THEN now() + make_interval(secs => ${lockSeconds}::double precision) ELSE NULL END)`,
				updatedAt: new Date(),
			})
			.where(eq(userSecurity.userId, userId))
			.returning();

		return row;
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
				refreshTokenId: session.refreshTokenId,
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

	async getSessionWithUser(
		id: string,
	): Promise<{ session: UserSession; user: User } | undefined> {
		const [row] = await db
			.select({ session: userSessions, user: users })
			.from(userSessions)
			.innerJoin(users, eq(userSessions.userId, users.id))
			.where(eq(userSessions.id, id))
			.limit(1);

		return row;
	}

	async rotateRefreshToken(
		sessionId: string,
		currentTokenId: string,
		nextTokenId: string,
	): Promise<UserSession | undefined> {
		const now = new Date();

		// `refresh_token_id = current` in the WHERE clause is the compare-and-swap: of two
		// requests presenting the same token, exactly one matches a row.
		const [row] = await db
			.update(userSessions)
			.set({
				refreshTokenId: nextTokenId,
				previousRefreshTokenId: currentTokenId,
				refreshRotatedAt: now,
				lastSeenAt: now,
			})
			.where(
				and(
					eq(userSessions.id, sessionId),
					eq(userSessions.refreshTokenId, currentTokenId),
				),
			)
			.returning();

		return row;
	}

	async deleteExpiredSessionsForUser(userId: string): Promise<void> {
		await db
			.delete(userSessions)
			.where(and(eq(userSessions.userId, userId), lt(userSessions.expiresAt, new Date())));
	}

	async revokeSessionForUser(userId: string, sessionId: string): Promise<boolean> {
		const removed = await db
			.delete(userSessions)
			.where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, userId)))
			.returning({ id: userSessions.id });

		return removed.length > 0;
	}

	async revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
		const removed = await db
			.delete(userSessions)
			.where(and(eq(userSessions.userId, userId), ne(userSessions.id, keepSessionId)))
			.returning({ id: userSessions.id });

		return removed.length;
	}

	async trimSessionsForUser(userId: string, keep: number): Promise<void> {
		const surplus = await db
			.select({ id: userSessions.id })
			.from(userSessions)
			.where(eq(userSessions.userId, userId))
			.orderBy(desc(userSessions.lastSeenAt), desc(userSessions.createdAt))
			.offset(keep);

		if (surplus.length === 0) return;

		await db.delete(userSessions).where(
			inArray(
				userSessions.id,
				surplus.map((row) => row.id),
			),
		);
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

	// ── Provider identities ─────────────────────────────────────────────────

	async findOAuthAccount(
		provider: OAuthProvider,
		providerUserId: string,
	): Promise<OAuthAccountRecord | undefined> {
		const [row] = await db
			.select()
			.from(oauthAccounts)
			.where(
				and(
					eq(oauthAccounts.provider, provider),
					eq(oauthAccounts.providerUserId, providerUserId),
				),
			)
			.limit(1);

		return row;
	}

	async listOAuthAccountsForUser(userId: string): Promise<OAuthAccountRecord[]> {
		return db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId));
	}

	async createOAuthAccount(account: OAuthAccountRecord): Promise<void> {
		await db.insert(oauthAccounts).values({
			id: account.id,
			userId: account.userId,
			provider: account.provider,
			providerUserId: account.providerUserId,
			createdAt: account.createdAt,
			lastLoginAt: account.lastLoginAt,
		});
	}

	async markOAuthLogin(id: string, at: Date): Promise<void> {
		await db.update(oauthAccounts).set({ lastLoginAt: at }).where(eq(oauthAccounts.id, id));
	}

	async reclaimAccount(userId: string): Promise<User | undefined> {
		// One transaction: either the account is fully cleaned and verified, or nothing changed.
		return db.transaction(async (tx) => {
			await tx
				.update(userSecurity)
				.set({
					passwordHash: null,
					failedLoginAttempts: 0,
					lockedUntil: null,
					updatedAt: new Date(),
				})
				.where(eq(userSecurity.userId, userId));
			await tx.delete(userSessions).where(eq(userSessions.userId, userId));
			await tx.delete(authTokens).where(eq(authTokens.userId, userId));

			const [row] = await tx
				.update(users)
				.set({
					emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())`,
					status: sql`(CASE WHEN ${users.status} = 'PENDING_VERIFICATION' THEN 'ACTIVE'::user_status ELSE ${users.status} END)`,
					updatedAt: new Date(),
				})
				.where(eq(users.id, userId))
				.returning();

			return row;
		});
	}

	// ── Audit trail ─────────────────────────────────────────────────────────

	async createAuditLog(entry: AuditLogRecord): Promise<void> {
		await db.insert(auditLogs).values({
			id: entry.id,
			userId: entry.userId,
			subjectId: entry.subjectId,
			event: entry.event,
			outcome: entry.outcome,
			ipAddress: entry.ipAddress,
			userAgent: entry.userAgent,
			// Drizzle JSON-encodes the object and Bun's driver encodes it again, so a plain object
			// lands as a jsonb STRING and `metadata->>'x'` queries return NULL. A bare ::jsonb cast
			// is not enough (the driver then types the parameter as jsonb and quotes the string
			// once more); forcing the parameter to text first sends it verbatim.
			metadata: sql`${JSON.stringify(entry.metadata)}::text::jsonb`,
			createdAt: entry.createdAt,
		});
	}

	async listAuditLogsForUser(
		userId: string,
		options: { limit: number; before?: Date | undefined },
	): Promise<AuditLogRecord[]> {
		return db
			.select()
			.from(auditLogs)
			.where(
				and(
					eq(auditLogs.userId, userId),
					options.before ? lt(auditLogs.createdAt, options.before) : undefined,
				),
			)
			.orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
			.limit(options.limit);
	}

	async getDeviceHistory(
		userId: string,
		deviceName: string,
		since: Date,
	): Promise<{ knownDevice: boolean; hasHistory: boolean }> {
		const signIns = and(
			eq(auditLogs.userId, userId),
			eq(auditLogs.outcome, "SUCCESS"),
			inArray(auditLogs.event, [AuditEvents.SIGN_UP, AuditEvents.SIGN_IN_SUCCESS]),
		);

		const [known] = await db
			.select({ id: auditLogs.id })
			.from(auditLogs)
			.where(
				and(
					signIns,
					gt(auditLogs.createdAt, since),
					sql`${auditLogs.metadata}->>'deviceName' = ${deviceName}`,
				),
			)
			.limit(1);

		if (known) return { knownDevice: true, hasHistory: true };

		const [any] = await db.select({ id: auditLogs.id }).from(auditLogs).where(signIns).limit(1);
		return { knownDevice: false, hasHistory: any !== undefined };
	}

	// ── One-time email tokens ───────────────────────────────────────────────

	async createAuthToken(token: AuthTokenRecord): Promise<void> {
		await db.insert(authTokens).values({
			id: token.id,
			userId: token.userId,
			type: token.type,
			tokenHash: token.tokenHash,
			newEmail: token.newEmail,
			expiresAt: token.expiresAt,
		});
	}

	async consumeAuthToken(
		tokenHash: string,
		type: AuthTokenType,
	): Promise<{ userId: string; newEmail: string | null } | undefined> {
		// Mark-as-used and check-validity in one statement: two requests carrying the same
		// link cannot both succeed.
		const [row] = await db
			.update(authTokens)
			.set({ usedAt: new Date() })
			.where(
				and(
					eq(authTokens.tokenHash, tokenHash),
					eq(authTokens.type, type),
					isNull(authTokens.usedAt),
					gt(authTokens.expiresAt, new Date()),
				),
			)
			.returning({ userId: authTokens.userId, newEmail: authTokens.newEmail });

		return row;
	}

	async deleteAuthTokensForUser(userId: string, type: AuthTokenType): Promise<void> {
		await db
			.delete(authTokens)
			.where(and(eq(authTokens.userId, userId), eq(authTokens.type, type)));
	}

	async changeUserEmail(userId: string, newEmail: string): Promise<User | undefined> {
		const [row] = await db
			.update(users)
			.set({
				email: newEmail.trim().toLowerCase(),
				// The link was delivered to the new mailbox, which proves control of it.
				emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())`,
				status: sql`(CASE WHEN ${users.status} = 'PENDING_VERIFICATION' THEN 'ACTIVE'::user_status ELSE ${users.status} END)`,
				updatedAt: new Date(),
			})
			.where(eq(users.id, userId))
			.returning();

		return row;
	}

	async markEmailVerified(userId: string): Promise<User | undefined> {
		const [row] = await db
			.update(users)
			.set({
				emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())`,
				status: sql`(CASE WHEN ${users.status} = 'PENDING_VERIFICATION' THEN 'ACTIVE'::user_status ELSE ${users.status} END)`,
				updatedAt: new Date(),
			})
			.where(eq(users.id, userId))
			.returning();

		return row;
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
		session?: UserSession;
		oauthAccount?: OAuthAccountRecord;
	}): Promise<User> {
		return db.transaction(async (tx) => {
			const [createdUser] = await tx
				.insert(users)
				.values({
					id: args.user.id,
					fullname: args.user.fullname,
					email: args.user.email.trim().toLowerCase(),
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

			if (args.session) {
				await tx.insert(userSessions).values({
					id: args.session.id,
					userId: createdUser.id,
					deviceName: args.session.deviceName,
					platform: args.session.platform,
					browser: args.session.browser,
					os: args.session.os,
					ipAddress: args.session.ipAddress,
					userAgent: args.session.userAgent,
					refreshTokenId: args.session.refreshTokenId,
					lastSeenAt: args.session.lastSeenAt,
					expiresAt: args.session.expiresAt,
				});
			}

			if (args.oauthAccount) {
				await tx.insert(oauthAccounts).values({
					id: args.oauthAccount.id,
					userId: createdUser.id,
					provider: args.oauthAccount.provider,
					providerUserId: args.oauthAccount.providerUserId,
					createdAt: args.oauthAccount.createdAt,
					lastLoginAt: args.oauthAccount.lastLoginAt,
				});
			}

			return createdUser as User;
		});
	}
}

let cached: Repository | null = null;

export const getAuthRepository = (): Repository => {
	if (!cached) cached = new DrizzleAuthRepository();
	return cached;
};

/** Swap the repository (tests use an in-memory one). Pass null to restore the Drizzle default. */
export const setAuthRepository = (repository: Repository | null): void => {
	cached = repository;
};
