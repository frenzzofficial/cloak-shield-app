export const UserRoles = {
	USER: "USER",
	ADMIN: "ADMIN",
} as const;

export const UserRolesValues = Object.values(UserRoles);

export type UserRole = keyof typeof UserRoles;

// Account status — distinct from is_verified/email_verified_at. A user can be
// ACTIVE but unverified (allowed to browse, not to do sensitive actions), or
// SUSPENDED (blocked entirely regardless of verification state).
export const UserStatuses = {
	ACTIVE: "ACTIVE",
	SUSPENDED: "SUSPENDED",
	DEACTIVATED: "DEACTIVATED",
	PENDING_VERIFICATION: "PENDING_VERIFICATION",
} as const;

export const userStatusValues = Object.values(UserStatuses);

export type UserStatus = keyof typeof UserStatuses;
