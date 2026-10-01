import { envAppConfig } from "../env/app.env";
import { envClientConfig } from "../env/client.env";
import { envPublicConfig } from "../env/public.env";

const base = `${envAppConfig.API_PREFIX}/${envAppConfig.API_VERSION}`;

const authRoutes = (base: string) => ({
	base,
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

	auth: {
		base: "/auth",
		authEmail: {
			...authRoutes("/auth/email"),
			signout: "/signout",
			refresh: "/refresh",
			me: "/me",
			verifyEmail: "/verify-email",
			forgotPassword: "/forgot-password",
			resetPassword: "/reset-password",
			session: "/sessions",
		},
		authPhone: {
			...authRoutes("/auth/phone"),
			sendOtp: "/send-otp",
			verifyOtp: "/verify-otp",
		},
	},
};
