import { envAppConfig } from "../../../packages/env/app.env";
import type { AuthPlugin } from "../core/plugin";
import { registerEmailAuthRoutes } from "./email.routes";

// Email + password. Switched by ENABLE_EMAIL_AUTH.
//
// NOTE: this plugin currently also owns the routes that are really about sessions rather than
// about passwords (refresh, signout, me, sessions, activity). Their URLs live under
// /api/v1/auth/email today, so they stay here until a second plugin needs them; at that point
// they move to core with canonical /api/v1/auth/* paths (and the refresh-cookie path migrates).
export const emailPlugin: AuthPlugin = {
	id: "email",
	kind: "password",
	label: "Email and password",
	enabled: envAppConfig.ENABLE_EMAIL_AUTH,
	provides: ["session-routes"],
	register: (app, core) => registerEmailAuthRoutes(app, core),
};
