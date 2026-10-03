import type { UserSession } from "@/packages/schema/user.schema";

/** Who is calling: parsed from the request, stored on sessions and in the audit trail. */
export interface DeviceInfo {
	deviceName: string;
	platform: string;
	browser: string;
	os: string;
	ipAddress: string;
	userAgent: string;
}

export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
}

/** A freshly issued login: the tokens plus the session they belong to (its expiry drives cookies). */
export interface SessionTokens {
	tokens: AuthTokens;
	session: UserSession;
}
