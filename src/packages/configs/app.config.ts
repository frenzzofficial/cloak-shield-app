import { envAppConfig } from "../env/app.env";
import { envClientConfig } from "../env/client.env";
import { envPublicConfig } from "../env/public.env";

const base = `${envAppConfig.API_PREFIX}/${envAppConfig.API_VERSION}`;

const authRoutes = (path: string) => ({
	// Path relative to the versioned API base, e.g. /auth/email
	base: path,
	// Full public path, e.g. /api/v1/auth/email
	path: `${base}${path}`,
	signin: "/signin",
	signup: "/signup",
});

export const appConfig = {
	app: {
		// Bind address for the local server (NOT the public URL).
		host: envAppConfig.HOST,
		port: envAppConfig.PORT,
		version: envPublicConfig.APP_VERSION,
		NODE_ENV: envAppConfig.NODE_ENV,
		domain: envPublicConfig.SITE_ORIGIN.replace(/^https?:\/\//, ""),
		apiPrefix: envAppConfig.API_PREFIX,
		apiVersion: envAppConfig.API_VERSION,
		bodyLimitBytes: envAppConfig.BODY_LIMIT_BYTES,
	},
	site: {
		name: envPublicConfig.APP_NAME,
		description: envPublicConfig.APP_DESCRIPTION,
		url: envPublicConfig.SITE_ORIGIN,
		message: "Welcome to Cloak Shield",
		documentation: envPublicConfig.SITE_DOCUMENTATION,
		api: envPublicConfig.SITE_API,
	},
	client: envClientConfig,

	// Every versioned route lives under this prefix, e.g. /api/v1
	api: {
		base,
	},

	account: {
		path: `${base}/account`,
		profile: "/profile",
		preferences: "/preferences",
		delete: "/delete",
	},

	auth: {
		base: "/auth",
		csrfToken: `${base}/csrf`,
		providers: `${base}/auth/providers`,
		authEmail: {
			...authRoutes("/auth/email"),
			signout: "/signout",
			refresh: "/refresh",
			me: "/me",
			verifyEmail: "/verify-email",
			resendVerification: "/resend-verification",
			forgotPassword: "/forgot-password",
			resetPassword: "/reset-password",
			session: "/sessions",
			sessionById: "/sessions/:id",
			revokeOtherSessions: "/sessions/revoke-others",
			changePassword: "/change-password",
			changeEmail: "/change-email",
			confirmEmailChange: "/confirm-email-change",
			activity: "/activity",
		},
		authGoogle: {
			base: "/auth/google",
			// e.g. /api/v1/auth/google
			path: `${base}/auth/google`,
			start: "/start",
			callback: "/callback",
		},
		authPhone: {
			...authRoutes("/auth/phone"),
			sendOtp: "/send-otp",
			verifyOtp: "/verify-otp",
		},
	},
};
