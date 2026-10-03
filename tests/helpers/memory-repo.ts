import type { AuthTokenType } from "@/packages/configs/auth-token.config";
import type {
	AuthTokenRecord,
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

	// ── One-time tokens ─────────────────────────────────────────────────────
	async createAuthToken(token: AuthTokenRecord): Promise<void> {
		if ([...this.tokens.values()].some((existing) => existing.tokenHash === token.tokenHash)) {
			throw uniqueViolation("auth_tokens_token_hash_unique");
		}
		this.tokens.set(token.id, { ...token });
	}

	async consumeAuthToken(tokenHash: string, type: AuthTokenType): Promise<string | undefined> {
		const token = [...this.tokens.values()].find(
			(candidate) => candidate.tokenHash === tokenHash && candidate.type === type,
		);
		if (!token || token.usedAt !== null || token.expiresAt.getTime() <= Date.now())
			return undefined;

		token.usedAt = new Date();
		return token.userId;
	}

	async deleteAuthTokensForUser(userId: string, type: AuthTokenType): Promise<void> {
		for (const [id, token] of this.tokens) {
			if (token.userId === userId && token.type === type) this.tokens.delete(id);
		}
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
		return user;
	}

	/** Test-only: direct access for backdating timestamps. */
	patchSession(id: string, patch: Partial<UserSession>): void {
		const session = this.sessions.get(id);
		if (session) this.sessions.set(id, { ...session, ...patch });
	}
}
