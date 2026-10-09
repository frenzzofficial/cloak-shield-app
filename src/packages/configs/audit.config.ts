// Security-relevant events worth keeping a trail of. The event column is plain text, so adding
// an event here needs no database migration.
export const AuditEvents = {
	SIGN_UP: "SIGN_UP",
	SIGN_IN_SUCCESS: "SIGN_IN_SUCCESS",
	SIGN_IN_FAILURE: "SIGN_IN_FAILURE",
	ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
	SIGN_OUT: "SIGN_OUT",
	REFRESH_REUSE_DETECTED: "REFRESH_REUSE_DETECTED",
	REAUTH_FAILURE: "REAUTH_FAILURE",
	EMAIL_VERIFIED: "EMAIL_VERIFIED",
	PASSWORD_RESET_REQUESTED: "PASSWORD_RESET_REQUESTED",
	PASSWORD_RESET_COMPLETED: "PASSWORD_RESET_COMPLETED",
	PASSWORD_CHANGED: "PASSWORD_CHANGED",
	EMAIL_CHANGE_REQUESTED: "EMAIL_CHANGE_REQUESTED",
	EMAIL_CHANGED: "EMAIL_CHANGED",
	SESSION_REVOKED: "SESSION_REVOKED",
	OTHER_SESSIONS_REVOKED: "OTHER_SESSIONS_REVOKED",
	PROFILE_UPDATED: "PROFILE_UPDATED",
	PREFERENCES_UPDATED: "PREFERENCES_UPDATED",
	ACCOUNT_DELETED: "ACCOUNT_DELETED",
	OAUTH_ACCOUNT_LINKED: "OAUTH_ACCOUNT_LINKED",
	// An unverified email account was claimed by whoever proved they own the mailbox (via a
	// provider): its password, sessions and pending links were wiped first.
	ACCOUNT_RECLAIMED: "ACCOUNT_RECLAIMED",
} as const;

export type AuditEvent = (typeof AuditEvents)[keyof typeof AuditEvents];

export type AuditOutcome = "SUCCESS" | "FAILURE";
