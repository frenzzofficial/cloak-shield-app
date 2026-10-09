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

export interface Repository {
	// ── Core user ────────────────────────────────────────────────────────────────

	findUserByEmail(email: string): Promise<User | undefined>;
	findUserById(id: string): Promise<User | undefined>;
	createUser(user: User): Promise<User>;
	updateUser(user: User): Promise<User>;
	deleteUser(userId: string): Promise<void>;

	getAllUsers(args?: { limit?: number; cursor?: string }): Promise<{
		users: User[];
		nextCursor: string | undefined;
	}>;

	// ── Security ────────────────────────────────────────────────────────────────

	getUserSecurity(userId: string): Promise<UserSecurity | undefined>;
	createUserSecurity(security: UserSecurity): Promise<UserSecurity>;
	updateUserSecurity(
		userId: string,
		patch: Partial<Omit<UserSecurity, "userId">>,
	): Promise<UserSecurity>;
	/**
	 * Atomically counts one failed sign-in and locks the account when `maxAttempts` is reached.
	 * An already-expired lock starts the count over at 1. Must be a single statement, so
	 * parallel guesses cannot all read the same counter.
	 */
	registerFailedLogin(
		userId: string,
		maxAttempts: number,
		lockSeconds: number,
	): Promise<UserSecurity | undefined>;

	// ── Profile ─────────────────────────────────────────────────────────────────

	getUserProfile(userId: string): Promise<UserProfile | undefined>;
	createUserProfile(profile: UserProfile): Promise<UserProfile>;
	updateUserProfile(
		userId: string,
		patch: Partial<Omit<UserProfile, "userId">>,
	): Promise<UserProfile>;

	// ── Preferences ─────────────────────────────────────────────────────────────

	getUserPreferences(userId: string): Promise<UserPreferences | undefined>;
	createUserPreferences(preferences: UserPreferences): Promise<UserPreferences>;
	updateUserPreferences(
		userId: string,
		patch: Partial<Omit<UserPreferences, "userId">>,
	): Promise<UserPreferences>;

	// ── Sessions ────────────────────────────────────────────────────────────────

	createSession(session: UserSession): Promise<UserSession>;
	getSession(id: string): Promise<UserSession | undefined>;
	/** Session + its owner in one round trip (used on every authenticated request). */
	getSessionWithUser(id: string): Promise<{ session: UserSession; user: User } | undefined>;
	/**
	 * Compare-and-swap rotation: succeeds only while `currentTokenId` is still the session's
	 * active refresh token. Returns undefined when someone else rotated first.
	 */
	rotateRefreshToken(
		sessionId: string,
		currentTokenId: string,
		nextTokenId: string,
	): Promise<UserSession | undefined>;
	deleteExpiredSessionsForUser(userId: string): Promise<void>;
	/** Deletes one session, but only if it belongs to `userId`. False when there was no match. */
	revokeSessionForUser(userId: string, sessionId: string): Promise<boolean>;
	/** Deletes every session of the user except `keepSessionId`. Returns how many were removed. */
	revokeOtherSessions(userId: string, keepSessionId: string): Promise<number>;
	/** Keeps the `keep` most recently used sessions and deletes the rest. */
	trimSessionsForUser(userId: string, keep: number): Promise<void>;
	revokeSession(id: string): Promise<void>;
	deleteSessionsForUser(userId: string): Promise<void>;
	listSessionsForUser(userId: string): Promise<UserSession[]>;

	// ── Provider identities ─────────────────────────────────────────────────────

	findOAuthAccount(
		provider: OAuthProvider,
		providerUserId: string,
	): Promise<OAuthAccountRecord | undefined>;
	listOAuthAccountsForUser(userId: string): Promise<OAuthAccountRecord[]>;
	/** Throws a unique violation if the identity or the (user, provider) pair already exists. */
	createOAuthAccount(account: OAuthAccountRecord): Promise<void>;
	markOAuthLogin(id: string, at: Date): Promise<void>;
	/**
	 * Takes over an account whose email was never verified, atomically: removes its password and
	 * lockout, every session, and every pending token, then marks the email verified (and
	 * PENDING_VERIFICATION becomes ACTIVE). Whoever registered it by email did not prove they own
	 * the address; whoever just signed in through a provider did.
	 */
	reclaimAccount(userId: string): Promise<User | undefined>;

	// ── Audit trail ─────────────────────────────────────────────────────────────

	createAuditLog(entry: AuditLogRecord): Promise<void>;
	/** Newest first. `before` pages backwards (exclusive). */
	listAuditLogsForUser(
		userId: string,
		options: { limit: number; before?: Date | undefined },
	): Promise<AuditLogRecord[]>;
	/**
	 * Has this user signed in (or registered) from this device name since `since`? `hasHistory`
	 * says whether they have any sign-in on record at all, so accounts that predate the audit
	 * trail are not flagged as "new device" on their first sign-in.
	 */
	getDeviceHistory(
		userId: string,
		deviceName: string,
		since: Date,
	): Promise<{ knownDevice: boolean; hasHistory: boolean }>;

	// ── One-time email tokens ─────────────────────────────────────────────────────

	createAuthToken(token: AuthTokenRecord): Promise<void>;
	/** Marks a valid, unused, unexpired token as used and returns its owner. Single use. */
	consumeAuthToken(
		tokenHash: string,
		type: AuthTokenType,
	): Promise<{ userId: string; newEmail: string | null } | undefined>;
	deleteAuthTokensForUser(userId: string, type: AuthTokenType): Promise<void>;
	/**
	 * Switches the account to a new, already-confirmed address (verified now; PENDING accounts
	 * become ACTIVE). Throws a unique violation if another account took the address meanwhile.
	 */
	changeUserEmail(userId: string, newEmail: string): Promise<User | undefined>;
	/** Sets emailVerifiedAt and moves PENDING_VERIFICATION accounts to ACTIVE. */
	markEmailVerified(userId: string): Promise<User | undefined>;

	// ── Transactional registration ──────────────────────────────────────────────

	createUserWithSession(args: {
		user: User;
		profile: UserProfile;
		security: UserSecurity;
		preferences: UserPreferences;
		/** Omitted when sign-up must wait for email verification before any session exists. */
		session?: UserSession;
		/** Provider sign-up: linked in the same transaction, so the account never exists half-made. */
		oauthAccount?: OAuthAccountRecord;
	}): Promise<User>;
}
