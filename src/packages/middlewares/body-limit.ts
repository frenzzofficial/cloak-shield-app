import type { Elysia } from "elysia";

import { envAppConfig } from "../env/app.env";
import { AppError } from "../utils/errors";

// Elysia parses JSON/text/form/multipart bodies automatically based on Content-Type — there's
// no separate "body parser" to install. What's missing is a size limit: without one, a client
// can send an arbitrarily large body and force the server to buffer all of it before your
// route (or even validation) ever runs.
//
// This checks the Content-Length header before any parsing happens, so an oversized request
// is rejected immediately. A request without Content-Length (e.g. chunked transfer encoding)
// is allowed through here; Bun's own server-level limit is the backstop for that case.
export const registerBodyLimit = (app: Elysia): void => {
	app.onRequest(({ request }) => {
		const contentLength = request.headers.get("content-length");
		if (contentLength === null) return;

		const size = Number(contentLength);
		if (Number.isFinite(size) && size > envAppConfig.BODY_LIMIT_BYTES) {
			throw AppError.payloadTooLarge(
				`Request body too large: ${size} bytes exceeds the ${envAppConfig.BODY_LIMIT_BYTES} byte limit`,
			);
		}
	});
};
