// Drizzle schema — source of truth for the database shape. Push it with:
//   bun run db:push       (dev: syncs straight to the DB, no migration files)
//   bun run db:generate   (prod: writes SQL migration files to review first)
//
// RLS is enabled with no policies on every table (via .enableRLS()), so only
// this app's DATABASE_URL / service-role access can read or write them.
import { relations } from "drizzle-orm";
import {
	boolean,
	date,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { AuditEvent, AuditOutcome } from "@/packages/configs/audit.config";

export const userRoleEnum = pgEnum("user_role", ["USER", "ADMIN"]);
export const userStatusEnum = pgEnum("user_status", [
	"ACTIVE",
	"SUSPENDED",
	"DEACTIVATED",
	"PENDING_VERIFICATION",
]);
export const genderEnum = pgEnum("gender", ["MALE", "FEMALE", "OTHER", "PREFER_NOT_TO_SAY"]);
export const themeEnum = pgEnum("theme", ["light", "dark", "system"]);
export const authTokenTypeEnum = pgEnum("auth_token_type", [
	"EMAIL_VERIFICATION",
	"PASSWORD_RESET",
	"EMAIL_CHANGE",
]);

// ── users ────────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
	id: uuid("id").primaryKey().defaultRandom(),
	fullname: text("fullname"),
	email: text("email").notNull().unique(),
	avatarUrl: text("avatar_url"),
	role: userRoleEnum("role").notNull().default("USER"),
	status: userStatusEnum("status").notNull().default("PENDING_VERIFICATION"),
	emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// ── user_security ────────────────────────────────────────────────────────────
export const userSecurity = pgTable("user_security", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	passwordHash: text("password_hash").notNull(),
	twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
	failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
	lockedUntil: timestamp("locked_until", { withTimezone: true }),
	lastPasswordChangedAt: timestamp("last_password_changed_at", {
		withTimezone: true,
	}),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// ── user_profiles ────────────────────────────────────────────────────────────
export const userProfiles = pgTable("user_profiles", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	username: text("username").unique(),
	bio: text("bio"),
	phone: text("phone"),
	birthDate: date("birth_date", { mode: "date" }),
	gender: genderEnum("gender"),
	timezone: text("timezone"),
	locale: text("locale"),
	website: text("website"),
	twitterUrl: text("twitter_url"),
	githubUrl: text("github_url"),
	linkedinUrl: text("linkedin_url"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// ── user_preferences ─────────────────────────────────────────────────────────
export const userPreferences = pgTable("user_preferences", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	theme: themeEnum("theme").notNull().default("system"),
	language: text("language").notNull().default("en"),
	emailNotifications: boolean("email_notifications").notNull().default(true),
	pushNotifications: boolean("push_notifications").notNull().default(true),
	marketingEmails: boolean("marketing_emails").notNull().default(false),
	reducedMotion: boolean("reduced_motion").notNull().default(false),
	highContrast: boolean("high_contrast").notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// ── user_sessions ────────────────────────────────────────────────────────────
// One row per issued refresh token / logged-in device — see auth.repository.ts
export const userSessions = pgTable(
	"user_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		deviceName: text("device_name").notNull().default("Unknown device"),
		platform: text("platform").notNull().default("unknown"),
		browser: text("browser").notNull().default("unknown"),
		os: text("os").notNull().default("unknown"),
		ipAddress: text("ip_address").notNull().default(""),
		userAgent: text("user_agent").notNull().default(""),
		// Refresh-token rotation. Only the token carrying `refreshTokenId` is accepted; the one
		// before it is remembered briefly (previousRefreshTokenId + refreshRotatedAt) so two
		// tabs refreshing at once don't log the user out, while an older replay revokes it.
		refreshTokenId: text("refresh_token_id").notNull().default(""),
		previousRefreshTokenId: text("previous_refresh_token_id"),
		refreshRotatedAt: timestamp("refresh_rotated_at", { withTimezone: true }),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("user_sessions_user_id_idx").on(table.userId)],
).enableRLS();

// ── auth_tokens ──────────────────────────────────────────────────────────────
// Single-use email-verification and password-reset tokens. Only a SHA-256 hash is stored,
// so a database leak does not hand out working links.
export const authTokens = pgTable(
	"auth_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		type: authTokenTypeEnum("type").notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		// EMAIL_CHANGE only: the address the link will switch the account to.
		newEmail: text("new_email"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		usedAt: timestamp("used_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("auth_tokens_user_id_idx").on(table.userId)],
).enableRLS();

// ── audit_logs ───────────────────────────────────────────────────────────────
// Append-only trail of security events. Deliberately holds no passwords, tokens or raw email
// addresses: failed sign-ins for unknown emails store a keyed hash, and when an account is
// deleted `user_id` becomes NULL while `subject_id` keeps the (now meaningless) account id so
// the history stays attributable without keeping personal data.
export const auditLogs = pgTable(
	"audit_logs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
		subjectId: text("subject_id"),
		event: text("event").$type<AuditEvent>().notNull(),
		outcome: text("outcome").$type<AuditOutcome>().notNull(),
		ipAddress: text("ip_address").notNull().default(""),
		userAgent: text("user_agent").notNull().default(""),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("audit_logs_user_created_idx").on(table.userId, table.createdAt),
		index("audit_logs_created_idx").on(table.createdAt),
	],
).enableRLS();

// ── relations (optional, enables db.query.users.findFirst({ with: {...} })) ──
export const usersRelations = relations(users, ({ one, many }) => ({
	security: one(userSecurity, {
		fields: [users.id],
		references: [userSecurity.userId],
	}),
	profile: one(userProfiles, {
		fields: [users.id],
		references: [userProfiles.userId],
	}),
	preferences: one(userPreferences, {
		fields: [users.id],
		references: [userPreferences.userId],
	}),
	sessions: many(userSessions),
}));

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
	user: one(users, { fields: [userSessions.userId], references: [users.id] }),
}));
