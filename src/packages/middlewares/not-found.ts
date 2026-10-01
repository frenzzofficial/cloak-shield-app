import type { Elysia } from "elysia";

// Explicit catch-all for anything no route matched. Elysia's router already falls through
// to onError's `code === "NOT_FOUND"` branch for this case (kept as a defensive fallback in
// error-handler.ts), but registering a real wildcard route here means a 404 body is built
// the same way as every other response, and makes "what happens on an unknown route" a
// named, visible piece of the app instead of an implicit framework default.
//
// IMPORTANT: register this LAST, after every other route. A wildcard route registered
// earlier would shadow anything registered after it.
export const registerNotFound = (app: Elysia): void => {
	app.all("*", ({ set, request }) => {
		set.status = 404;
		const { pathname } = new URL(request.url);
		return { success: false, message: `Route not found: ${request.method} ${pathname}` };
	});
};
