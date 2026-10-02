import type {
	User,
	UserPreferences,
	UserProfile,
	UserSecurity,
	UserSession,
} from "../packages/schema/user.schema";

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
	revokeSession(id: string): Promise<void>;
	deleteSessionsForUser(userId: string): Promise<void>;
	listSessionsForUser(userId: string): Promise<UserSession[]>;

	// ── Transactional registration ──────────────────────────────────────────────

	createUserWithSession(args: {
		user: User;
		profile: UserProfile;
		security: UserSecurity;
		preferences: UserPreferences;
		session: UserSession;
	}): Promise<User>;
}
