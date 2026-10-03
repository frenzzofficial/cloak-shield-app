import { z } from "zod";
import { limitRules, pageRules, uuidRules } from "@/packages/configs/schemas.config";

/**
 * common.schema.ts
 * --------------------------------------------------------------
 * Reusable Zod schemas shared across features — pagination, id params,
 * that sort of thing. Feature-specific schemas (auth.schema.ts,
 * user.schema.ts) compose these rather than redefining pagination shape
 * per endpoint.
 */

/** Query-string pagination — `?page=2&limit=20`. Both fields coerce from string and default sensibly. */
export const paginationSchema = z.object({
	page: pageRules,
	limit: limitRules,
});

export type Pagination = z.infer<typeof paginationSchema>;

/** A route param that must be a UUID — `/users/[id]`, `/posts/[id]`, etc. */
export const idParamSchema = z.object({
	id: uuidRules,
});

export type IdParam = z.infer<typeof idParamSchema>;

/** Wraps any item schema into the standard `{ data, page, limit, total }` list-response shape. */
export const paginatedResponseSchema = <ItemSchema extends z.ZodTypeAny>(itemSchema: ItemSchema) =>
	z.object({
		data: z.array(itemSchema),
		page: z.number().int().positive(),
		limit: z.number().int().positive(),
		total: z.number().int().nonnegative(),
	});

/** Freeform search/filter query string — trimmed, capped to a sane length to guard against abuse. */
export const searchQuerySchema = z.object({
	q: z.string().trim().max(200).default(""),
});
