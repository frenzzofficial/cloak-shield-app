import type { Elysia } from "elysia";

import { type AuthPlugin, type AuthPluginMeta, mountAuthPlugins } from "./core/plugin";
import { emailPlugin } from "./email/email.plugin";

// The composition root for sign-in methods: the ONE place that knows which plugins exist.
// Adding Google later is one import and one array entry here, plus its own folder.
const authPlugins: readonly AuthPlugin[] = [emailPlugin];

export const registerAuthPlugins = (
	app: Elysia,
	plugins: readonly AuthPlugin[] = authPlugins,
): AuthPluginMeta[] => mountAuthPlugins(app, plugins);
