import type { Elysia } from "elysia";

import { appConfig } from "../configs/app.config";
import { getHTML } from "../utils/static-files";

// Explicit catch-all for anything no route matched. Elysia's router already falls through
// to onError's `code === "NOT_FOUND"` branch for this case (kept as a defensive fallback in
// error-handler.ts), but registering a real wildcard route here means a 404 body is built
// the same way as every other response, and makes "what happens on an unknown route" a
// named, visible piece of the app instead of an implicit framework default.
//
// API clients (anything under the API prefix) get a JSON body; browsers hitting any other
// unknown URL get the HTML 404 page.
//
// IMPORTANT: register this LAST, after every other route. A wildcard route registered
// earlier would shadow anything registered after it.

const NOT_FOUND_HTML = "./html/404.html";

export const registerNotFound = (app: Elysia): void => {
	app.all("*", async ({ set, request }) => {
		const url = new URL(request.url);
		const { pathname } = url;

		if (
			pathname === appConfig.app.apiPrefix ||
			pathname.startsWith(`${appConfig.app.apiPrefix}/`)
		) {
			set.status = 404;

			return {
				success: false,
				message: `Route not found: ${request.method} ${pathname}`,
			};
		}

		try {
			const html = await getHTML(NOT_FOUND_HTML);

			if (!html) {
				set.status = 404;
				return "Not Found";
			}

			set.status = 404;
			set.headers["Content-Type"] = "text/html; charset=utf-8";

			return html;
		} catch {
			set.status = 404;
			set.headers["content-type"] = "text/plain; charset=utf-8";

			return "Page not found";
		}
	});
};
