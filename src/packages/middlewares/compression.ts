import type { Elysia } from "elysia";

import { envAppConfig } from "../env/app.env";

// Gzip-compresses JSON responses when the client sends `Accept-Encoding: gzip`.
//
// There's no elysia compression plugin that actually works against this Elysia version —
// the two on npm (elysia-compress, elysia-compression) both try to
// `import { mapResponse } from "elysia"`, but `mapResponse` is an instance METHOD
// (`app.mapResponse(...)`, a lifecycle hook like `.onError`), not a standalone export —
// so both packages fail to even load. This uses that same hook directly, with Bun's
// built-in `Bun.gzipSync` (no dependency needed).
//
// Bun doesn't have a native brotli encoder, so this only offers gzip. That covers every
// realistic client; deflate/brotli support was not worth the added complexity here.
//
// NOTE for Vercel deployments: Vercel's edge network already compresses responses for
// you, so this mostly matters for self-hosting / running behind a plain reverse proxy.
// On Vercel it's harmless but redundant CPU work inside the function — leave
// ENABLE_COMPRESSION=false there unless you've measured it actually helps.
const MIN_BYTES_TO_COMPRESS = 1024;

export const registerCompression = (app: Elysia): void => {
	if (!envAppConfig.ENABLE_COMPRESSION) return;

	app.mapResponse(({ responseValue, request, set }) => {
		if (responseValue instanceof Response) return; // already a full Response; leave as-is

		const acceptEncoding = request.headers.get("accept-encoding") ?? "";
		if (!acceptEncoding.includes("gzip")) return;

		const body =
			typeof responseValue === "string" ? responseValue : JSON.stringify(responseValue);
		const bytes = new TextEncoder().encode(body);
		if (bytes.byteLength < MIN_BYTES_TO_COMPRESS) return;

		const compressed = Bun.gzipSync(bytes);

		const headers = new Headers();
		headers.set("content-encoding", "gzip");
		headers.set(
			"content-type",
			typeof responseValue === "string"
				? "text/plain;charset=utf-8"
				: "application/json;charset=utf-8",
		);
		if (set.headers) {
			for (const [key, value] of Object.entries(set.headers)) {
				if (typeof value === "string") headers.set(key, value);
			}
		}

		return new Response(compressed, {
			status: typeof set.status === "number" ? set.status : 200,
			headers,
		});
	});
};
