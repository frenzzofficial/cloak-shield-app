import type { Elysia } from "elysia";
import { isUniqueViolation } from "../utils/db-errors";
import { AppError } from "../utils/errors";
import { logger } from "../utils/logger";

interface FieldError {
	field: string;
	message: string;
}

type ErrorBody = { success: false; message: string; errors?: FieldError[] };

const body = (message: string, errors?: FieldError[]): ErrorBody =>
	errors && errors.length > 0 ? { success: false, message, errors } : { success: false, message };

// Elysia reports every failed rule; a password that is too short AND missing a digit appears
// twice. One message per field is what a form needs, so keep the first for each path.
const toFieldErrors = (issues: ReadonlyArray<{ path: string; message: string }>): FieldError[] => {
	const seen = new Set<string>();
	const result: FieldError[] = [];

	for (const issue of issues) {
		const field = issue.path.replace(/^\//, "").replaceAll("/", ".") || "body";
		if (seen.has(field)) continue;
		seen.add(field);
		result.push({ field, message: issue.message });
	}

	return result;
};

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
				return body("Validation failed", toFieldErrors(error.all));
			default:
				break;
		}

		// A unique constraint that slipped past a pre-check (two requests racing) is a
		// conflict, not a server fault.
		if (isUniqueViolation(error)) {
			set.status = 409;
			return body("Resource already exists");
		}

		logger.error("unhandled error", {
			code: String(code),
			message: error instanceof Error ? error.message : String(error),
			// Drizzle wraps the real database error ("relation ... does not exist") in a generic
			// "Failed query" one; without the cause the log cannot say what actually went wrong.
			cause:
				error instanceof Error && error.cause instanceof Error
					? error.cause.message
					: undefined,
			stack: error instanceof Error ? error.stack : undefined,
		});

		set.status = 500;
		return body("Internal server error");
	});
};
