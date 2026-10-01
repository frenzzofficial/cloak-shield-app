import type { Elysia } from "elysia";
import { getHTML, getStaticAsset } from "../../packages/utils/static-files.js";

const STATIC_PAGES = new Map<string, string>([
	["/", "html/index.html"],
	["/home", "html/index.html"],
	["/docs", "html/docs.html"],
]);

export const registerStaticRoutes = (app: Elysia): Elysia => {
	// HTML pages
	for (const [route, file] of STATIC_PAGES) {
		app.get(route, async ({ set }) => {
			const html = await getHTML(file);

			if (!html) {
				set.status = 404;
				return "Not Found";
			}

			set.headers["Content-Type"] = "text/html; charset=utf-8";

			return html;
		});
	}

	// Static assets
	app.get("/assets/*", async ({ request, set }) => {
		const url = new URL(request.url);
		const assetPath = url.pathname.slice("/assets/".length);

		const asset = await getStaticAsset(assetPath);

		if (!asset) {
			set.status = 404;
			return "Not Found";
		}

		set.headers["Content-Type"] = asset.contentType;
		set.headers["Cache-Control"] = "public, max-age=31536000, immutable";

		return new Uint8Array(asset.body);
	});

	return app;
};
