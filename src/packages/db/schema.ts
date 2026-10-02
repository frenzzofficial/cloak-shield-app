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
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["USER", "ADMIN"]);
export const userStatusEnum = pgEnum("user_status", [
	"ACTIVE",
	"SUSPENDED",
	"DEACTIVATED",
	"PENDING_VERIFICATION",
]);
export const genderEnum = pgEnum("gender", ["MALE", "FEMALE", "OTHER", "PREFER_NOT_TO_SAY"]);
export const themeEnum = pgEnum("theme", ["light", "dark", "system"]);

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
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("user_sessions_user_id_idx").on(table.userId)],
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
