import type { Elysia } from "elysia";

import { appConfig } from "@/packages/configs/app.config";
import { recordAudit } from "./audit.service";
import {
	clearAuthCookies,
	readRefreshToken,
	setAuthCookies,
	wantsTokensInBody,
} from "./auth-cookies";
import { extractDeviceInfo } from "./device";
import { requirePassword } from "./reauth";
import { isBlocked, startSession } from "./session.service";

// ── The contract ───────────────────────────────────────────────────────────────
//
// A sign-in method (email, Google, Discord, ...) is a plugin: it owns its routes, its services
// and its own env section, and talks to the rest of the system ONLY through `AuthCore`.
//
// Boundaries (enforced by `bun run arch`, see .dependency-cruiser.cjs):
//   - a plugin may import `core/` and `packages/`, never another plugin
//   - `core/` never imports a plugin
//   - code outside `auth/` (e.g. account) imports `core/`, never a plugin
//
// That is what makes a plugin removable, switchable by env flag, or mountable on its own.

export type AuthPluginId = "email" | "google" | "discord";

/** "password": the user types credentials into our form. "oauth": we redirect to a provider. */
export type AuthPluginKind = "password" | "oauth";

/** What a frontend may learn about a method: enough to draw a button, nothing sensitive. */
export interface AuthPluginMeta {
	id: AuthPluginId;
	kind: AuthPluginKind;
	label: string;
}

export interface AuthPlugin extends AuthPluginMeta {
	/**
	 * Read from the plugin's OWN env section. A disabled plugin registers nothing, is absent from
	 * /auth/providers, and must not require any of its configuration to be set.
	 */
	enabled: boolean;
	register(app: Elysia, core: AuthCore): void;
}

/**
 * The only thing a plugin may depend on. It is an object (not module imports) so that a plugin
 * can be tested against a fake core, and so the core could one day be swapped for a remote one.
 */
export interface AuthCore {
	readonly sessions: {
		start: typeof startSession;
		isBlocked: typeof isBlocked;
	};
	readonly audit: { record: typeof recordAudit };
	readonly cookies: {
		set: typeof setAuthCookies;
		clear: typeof clearAuthCookies;
		readRefreshToken: typeof readRefreshToken;
		wantsTokensInBody: typeof wantsTokensInBody;
	};
	readonly device: { extract: typeof extractDeviceInfo };
	readonly reauth: { requirePassword: typeof requirePassword };
}

export const createAuthCore = (): AuthCore =>
	Object.freeze({
		sessions: { start: startSession, isBlocked },
		audit: { record: recordAudit },
		cookies: {
			set: setAuthCookies,
			clear: clearAuthCookies,
			readRefreshToken,
			wantsTokensInBody,
		},
		device: { extract: extractDeviceInfo },
		reauth: { requirePassword },
	});

// ── The registry ───────────────────────────────────────────────────────────────

const metaOf = ({ id, kind, label }: AuthPlugin): AuthPluginMeta => ({ id, kind, label });

/**
 * Mounts every ENABLED plugin and the public /auth/providers listing. Returns the metadata of
 * what was mounted, so callers can decide what else to register (account routes need at least
 * one way to sign in).
 *
 * Fails fast at boot on a duplicate id: two plugins claiming "google" is a programming error,
 * and silently letting the second shadow the first would be a security bug waiting to happen.
 */
export const mountAuthPlugins = (
	app: Elysia,
	plugins: readonly AuthPlugin[],
	core: AuthCore = createAuthCore(),
): AuthPluginMeta[] => {
	const seen = new Set<AuthPluginId>();

	for (const plugin of plugins) {
		if (seen.has(plugin.id)) {
			throw new Error(`Auth plugin "${plugin.id}" is registered twice`);
		}
		seen.add(plugin.id);
	}

	const enabled = plugins.filter((plugin) => plugin.enabled);
	for (const plugin of enabled) plugin.register(app, core);

	const providers = enabled.map(metaOf);

	app.get(appConfig.auth.providers, ({ status }) => status(200, { success: true, providers }), {
		detail: {
			tags: ["Auth"],
			summary: "Enabled sign-in methods",
			description:
				"Which sign-in methods this server offers, so a frontend can draw the right buttons.",
		},
	});

	return providers;
};
