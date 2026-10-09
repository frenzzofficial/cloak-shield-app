import type { AuthTokenType } from "@/packages/configs/auth-token.config";
import type { OAuthProvider } from "@/packages/configs/oauth-provider.config";
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

const uniqueViolation = (constraint: string): Error =>
	Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
		errno: "23505",
	});

/**
 * Behaves like the Drizzle repository (unique emails, cascade deletes, compare-and-swap rotation,
 * single-use tokens) so the HTTP flow suite can run without a database.
 */
export class InMemoryAuthRepository implements Repository {
	private users = new Map<string, User>();
	private security = new Map<string, UserSecurity>();
	private profiles = new Map<string, UserProfile>();
	private preferences = new Map<string, UserPreferences>();
	private sessions = new Map<string, UserSession>();
	private tokens = new Map<string, AuthTokenRecord>();
	private audit: AuditLogRecord[] = [];
	private oauth = new Map<string, OAuthAccountRecord>();

	// ── Core user ───────────────────────────────────────────────────────────
	async findUserByEmail(email: string): Promise<User | undefined> {
		const wanted = email.trim().toLowerCase();
		return [...this.users.values()].find((user) => user.email === wanted);
	}

	async findUserById(id: string): Promise<User | undefined> {
		return this.users.get(id);
	}

	async getAllUsers(args?: {
		limit?: number;
		cursor?: string;
	}): Promise<{ users: User[]; nextCursor: string | undefined }> {
		const ordered = [...this.users.values()].sort((a, b) => a.id.localeCompare(b.id));
		const start = args?.cursor ? ordered.findIndex((user) => user.id > (args.cursor ?? "")) : 0;
		const page = start < 0 ? [] : ordered.slice(start, start + (args?.limit ?? 50));
		const last = page[page.length - 1];
		const hasMore = start >= 0 && start + page.length < ordered.length;
		return { users: page, nextCursor: hasMore ? last?.id : undefined };
	}

	async createUser(user: User): Promise<User> {
		const email = user.email.trim().toLowerCase();
		if (await this.findUserByEmail(email)) throw uniqueViolation("users_email_unique");
		const stored = { ...user, email };
		this.users.set(stored.id, stored);
		return stored;
	}

	async updateUser(user: User): Promise<User> {
		if (!this.users.has(user.id)) throw AppError.notFound("User not found");
		const stored = { ...user, email: user.email.trim().toLowerCase(), updatedAt: new Date() };
		this.users.set(stored.id, stored);
		return stored;
	}

	async deleteUser(id: string): Promise<void> {
		this.users.delete(id);
		this.security.delete(id);
		this.profiles.delete(id);
		this.preferences.delete(id);
		await this.deleteSessionsForUser(id);
		for (const [key, token] of this.tokens) if (token.userId === id) this.tokens.delete(key);
		for (const [key, account] of this.oauth) if (account.userId === id) this.oauth.delete(key);
		// Like ON DELETE SET NULL: history stays, the link to the account goes.
		this.audit = this.audit.map((entry) =>
			entry.userId === id ? { ...entry, userId: null } : entry,
		);
	}

	// ── Security ────────────────────────────────────────────────────────────
	async getUserSecurity(userId: string): Promise<UserSecurity | undefined> {
		return this.security.get(userId);
	}

	async createUserSecurity(security: UserSecurity): Promise<UserSecurity> {
		this.security.set(security.userId, security);
		return security;
	}

	async updateUserSecurity(
		userId: string,
		patch: Partial<Omit<UserSecurity, "userId">>,
	): Promise<UserSecurity> {
		const current = this.security.get(userId);
		if (!current) throw AppError.notFound("User security not found");
		const next = { ...current, ...patch, updatedAt: new Date() };
		this.security.set(userId, next);
		return next;
	}

	async registerFailedLogin(
		userId: string,
		maxAttempts: number,
		lockSeconds: number,
	): Promise<UserSecurity | undefined> {
		const current = this.security.get(userId);
		if (!current) return undefined;

		const now = Date.now();
		const lockExpired = current.lockedUntil !== null && current.lockedUntil.getTime() <= now;
		const count = lockExpired ? 1 : current.failedLoginAttempts + 1;

		const next: UserSecurity = {
			...current,
			failedLoginAttempts: count,
			lockedUntil: count >= maxAttempts ? new Date(now + lockSeconds * 1_000) : null,
			updatedAt: new Date(),
		};
		this.security.set(userId, next);
		return next;
	}

	// ── Profile / preferences ───────────────────────────────────────────────
	async getUserProfile(userId: string): Promise<UserProfile | undefined> {
		return this.profiles.get(userId);
	}

	async createUserProfile(profile: UserProfile): Promise<UserProfile> {
		this.profiles.set(profile.userId, profile);
		return profile;
	}

	async updateUserProfile(
		userId: string,
		patch: Partial<Omit<UserProfile, "userId">>,
	): Promise<UserProfile> {
		const current = this.profiles.get(userId);
		if (!current) throw AppError.notFound("User profile not found");
		// Like the real UNIQUE(username) index.
		const wanted = patch.username;
		if (
			wanted &&
			[...this.profiles.values()].some((p) => p.userId !== userId && p.username === wanted)
		) {
			throw uniqueViolation("user_profiles_username_unique");
		}
		const next = { ...current, ...patch, updatedAt: new Date() };
		this.profiles.set(userId, next);
		return next;
	}

	async getUserPreferences(userId: string): Promise<UserPreferences | undefined> {
		return this.preferences.get(userId);
	}

	async createUserPreferences(preferences: UserPreferences): Promise<UserPreferences> {
		this.preferences.set(preferences.userId, preferences);
		return preferences;
	}

	async updateUserPreferences(
		userId: string,
		patch: Partial<Omit<UserPreferences, "userId">>,
	): Promise<UserPreferences> {
		const current = this.preferences.get(userId);
		if (!current) throw AppError.notFound("User preferences not found");
		const next = { ...current, ...patch, updatedAt: new Date() };
		this.preferences.set(userId, next);
		return next;
	}

	// ── Sessions ────────────────────────────────────────────────────────────
	async createSession(session: UserSession): Promise<UserSession> {
		this.sessions.set(session.id, { ...session });
		return { ...session };
	}

	async getSession(id: string): Promise<UserSession | undefined> {
		const session = this.sessions.get(id);
		return session ? { ...session } : undefined;
	}

	async getSessionWithUser(id: string) {
		const session = this.sessions.get(id);
		const user = session ? this.users.get(session.userId) : undefined;
		return session && user ? { session: { ...session }, user } : undefined;
	}

	async rotateRefreshToken(
		sessionId: string,
		currentTokenId: string,
		nextTokenId: string,
	): Promise<UserSession | undefined> {
		const session = this.sessions.get(sessionId);
		if (!session || session.refreshTokenId !== currentTokenId) return undefined;

		const now = new Date();
		const next: UserSession = {
			...session,
			refreshTokenId: nextTokenId,
			previousRefreshTokenId: currentTokenId,
			refreshRotatedAt: now,
			lastSeenAt: now,
		};
		this.sessions.set(sessionId, next);
		return { ...next };
	}

	async revokeSession(id: string): Promise<void> {
		this.sessions.delete(id);
	}

	async deleteSessionsForUser(userId: string): Promise<void> {
		for (const [id, session] of this.sessions)
			if (session.userId === userId) this.sessions.delete(id);
	}

	async listSessionsForUser(userId: string): Promise<UserSession[]> {
		return [...this.sessions.values()]
			.filter((session) => session.userId === userId)
			.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
			.map((session) => ({ ...session }));
	}

	async revokeSessionForUser(userId: string, sessionId: string): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		if (!session || session.userId !== userId) return false;
		this.sessions.delete(sessionId);
		return true;
	}

	async revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
		let removed = 0;
		for (const [id, session] of this.sessions) {
			if (session.userId === userId && id !== keepSessionId) {
				this.sessions.delete(id);
				removed += 1;
			}
		}
		return removed;
	}

	async deleteExpiredSessionsForUser(userId: string): Promise<void> {
		const now = Date.now();
		for (const [id, session] of this.sessions) {
			if (session.userId === userId && session.expiresAt.getTime() < now)
				this.sessions.delete(id);
		}
	}

	async trimSessionsForUser(userId: string, keep: number): Promise<void> {
		const surplus = (await this.listSessionsForUser(userId)).slice(keep);
		for (const session of surplus) this.sessions.delete(session.id);
	}

	// ── Provider identities ─────────────────────────────────────────────────
	async findOAuthAccount(
		provider: OAuthProvider,
		providerUserId: string,
	): Promise<OAuthAccountRecord | undefined> {
		const found = [...this.oauth.values()].find(
			(account) => account.provider === provider && account.providerUserId === providerUserId,
		);
		return found ? { ...found } : undefined;
	}

	async listOAuthAccountsForUser(userId: string): Promise<OAuthAccountRecord[]> {
		return [...this.oauth.values()]
			.filter((account) => account.userId === userId)
			.map((account) => ({ ...account }));
	}

	async createOAuthAccount(account: OAuthAccountRecord): Promise<void> {
		const taken = [...this.oauth.values()].some(
			(existing) =>
				(existing.provider === account.provider &&
					existing.providerUserId === account.providerUserId) ||
				(existing.userId === account.userId && existing.provider === account.provider),
		);
		if (taken) throw uniqueViolation("oauth_accounts_unique");
		this.oauth.set(account.id, { ...account });
	}

	async markOAuthLogin(id: string, at: Date): Promise<void> {
		const account = this.oauth.get(id);
		if (account) this.oauth.set(id, { ...account, lastLoginAt: at });
	}

	async reclaimAccount(userId: string): Promise<User | undefined> {
		const user = this.users.get(userId);
		const security = this.security.get(userId);
		if (!user || !security) return undefined;

		this.security.set(userId, {
			...security,
			passwordHash: null,
			failedLoginAttempts: 0,
			lockedUntil: null,
			updatedAt: new Date(),
		});
		await this.deleteSessionsForUser(userId);
		for (const [id, token] of this.tokens) if (token.userId === userId) this.tokens.delete(id);

		const next: User = {
			...user,
			emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
			status: user.status === "PENDING_VERIFICATION" ? "ACTIVE" : user.status,
			updatedAt: new Date(),
		};
		this.users.set(userId, next);
		return next;
	}

	// ── Audit trail ─────────────────────────────────────────────────────────
	async createAuditLog(entry: AuditLogRecord): Promise<void> {
		this.audit.push({ ...entry });
	}

	async listAuditLogsForUser(
		userId: string,
		options: { limit: number; before?: Date | undefined },
	): Promise<AuditLogRecord[]> {
		const before = options.before?.getTime();
		return this.audit
			.filter((entry) => entry.userId === userId)
			.filter((entry) => before === undefined || entry.createdAt.getTime() < before)
			.sort(
				(a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
			)
			.slice(0, options.limit);
	}

	async getDeviceHistory(
		userId: string,
		deviceName: string,
		since: Date,
	): Promise<{ knownDevice: boolean; hasHistory: boolean }> {
		const signIns = this.audit.filter(
			(entry) =>
				entry.userId === userId &&
				entry.outcome === "SUCCESS" &&
				(entry.event === "SIGN_UP" || entry.event === "SIGN_IN_SUCCESS"),
		);
		const knownDevice = signIns.some(
			(entry) =>
				entry.createdAt.getTime() > since.getTime() &&
				entry.metadata.deviceName === deviceName,
		);
		return { knownDevice, hasHistory: signIns.length > 0 };
	}

	/** Test-only: forget a user's audit history (an account that predates the trail). */
	wipeAuditFor(userId: string): void {
		this.audit = this.audit.filter((entry) => entry.userId !== userId);
	}

	/** Test-only: every audit row, for assertions on what is (not) stored. */
	allAuditLogs(): AuditLogRecord[] {
		return this.audit.map((entry) => ({ ...entry }));
	}

	// ── One-time tokens ─────────────────────────────────────────────────────
	async createAuthToken(token: AuthTokenRecord): Promise<void> {
		if ([...this.tokens.values()].some((existing) => existing.tokenHash === token.tokenHash)) {
			throw uniqueViolation("auth_tokens_token_hash_unique");
		}
		this.tokens.set(token.id, { ...token });
	}

	async consumeAuthToken(
		tokenHash: string,
		type: AuthTokenType,
	): Promise<{ userId: string; newEmail: string | null } | undefined> {
		const token = [...this.tokens.values()].find(
			(candidate) => candidate.tokenHash === tokenHash && candidate.type === type,
		);
		if (!token || token.usedAt !== null || token.expiresAt.getTime() <= Date.now())
			return undefined;

		token.usedAt = new Date();
		return { userId: token.userId, newEmail: token.newEmail };
	}

	async deleteAuthTokensForUser(userId: string, type: AuthTokenType): Promise<void> {
		for (const [id, token] of this.tokens) {
			if (token.userId === userId && token.type === type) this.tokens.delete(id);
		}
	}

	async changeUserEmail(userId: string, newEmail: string): Promise<User | undefined> {
		const user = this.users.get(userId);
		if (!user) return undefined;

		const email = newEmail.trim().toLowerCase();
		const owner = await this.findUserByEmail(email);
		if (owner && owner.id !== userId) throw uniqueViolation("users_email_unique");

		const next: User = {
			...user,
			email,
			emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
			status: user.status === "PENDING_VERIFICATION" ? "ACTIVE" : user.status,
			updatedAt: new Date(),
		};
		this.users.set(userId, next);
		return next;
	}

	async markEmailVerified(userId: string): Promise<User | undefined> {
		const user = this.users.get(userId);
		if (!user) return undefined;

		const next: User = {
			...user,
			emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
			status: user.status === "PENDING_VERIFICATION" ? "ACTIVE" : user.status,
			updatedAt: new Date(),
		};
		this.users.set(userId, next);
		return next;
	}

	// ── Transactional registration ──────────────────────────────────────────
	async createUserWithSession(args: {
		user: User;
		profile: UserProfile;
		security: UserSecurity;
		preferences: UserPreferences;
		session?: UserSession;
		oauthAccount?: OAuthAccountRecord;
	}): Promise<User> {
		// Everything is validated first, then written, so a failure leaves nothing behind
		// (the real implementation gets the same guarantee from a transaction).
		const email = args.user.email.trim().toLowerCase();
		if (await this.findUserByEmail(email)) throw uniqueViolation("users_email_unique");

		const user = { ...args.user, email };
		this.users.set(user.id, user);
		this.security.set(user.id, { ...args.security, userId: user.id });
		this.profiles.set(user.id, { ...args.profile, userId: user.id });
		this.preferences.set(user.id, { ...args.preferences, userId: user.id });
		if (args.session) this.sessions.set(args.session.id, { ...args.session, userId: user.id });

		if (args.oauthAccount) {
			// Same atomicity as the real transaction: if the identity is taken, nothing was created.
			const taken = [...this.oauth.values()].some(
				(a) =>
					a.provider === args.oauthAccount?.provider &&
					a.providerUserId === args.oauthAccount.providerUserId,
			);
			if (taken) {
				this.users.delete(user.id);
				this.security.delete(user.id);
				this.profiles.delete(user.id);
				this.preferences.delete(user.id);
				this.sessions.delete(args.session?.id ?? "");
				throw uniqueViolation("oauth_accounts_provider_identity_uq");
			}
			this.oauth.set(args.oauthAccount.id, { ...args.oauthAccount, userId: user.id });
		}
		return user;
	}

	/** Test-only: direct access for backdating timestamps. */
	patchSession(id: string, patch: Partial<UserSession>): void {
		const session = this.sessions.get(id);
		if (session) this.sessions.set(id, { ...session, ...patch });
	}
}
