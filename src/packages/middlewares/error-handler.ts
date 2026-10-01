import type { Elysia } from "elysia";
import { AppError } from "../utils/errors";
import { logger } from "../utils/logger";

type ErrorBody = { success: false; message: string };

const body = (message: string): ErrorBody => ({ success: false, message });

// Single place for all error handling. AppError is the only error type
// thrown from services (see errors.ts) — anything else is a programming
// error or a framework-level failure.
//
// IMPORTANT: register this BEFORE every route. Elysia hooks only apply to
// routes that are registered after them.
export const registerErrorHandler = (app: Elysia): void => {
	app.onError({ as: "global" }, ({ error, code, set }) => {
		if (error instanceof AppError) {
			if (!error.isOperational) {
				logger.error("non-operational error", {
					message: error.message,
					stack: error.stack,
				});
			}

			set.status = error.statusCode;
			return body(error.message);
		}

		switch (code) {
			case "NOT_FOUND":
				set.status = 404;
				return body("Not found");
			case "PARSE":
				set.status = 400;
				return body("Invalid request body");
			// Elysia's own `body: zodSchema` validation surfaces here.
			case "VALIDATION":
				set.status = 422;
				return body("Validation failed");
			default:
				break;
		}

		logger.error("unhandled error", {
			code: String(code),
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});

		set.status = 500;
		return body("Internal server error");
	});
};
