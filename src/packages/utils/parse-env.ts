import { z } from "zod";

/**
 * Parses environment input with a Zod schema and fails loudly with a readable list of
 * every problem, instead of a generic "validation failed" message.
 */
export const parseEnv = <TSchema extends z.ZodType>(
	schema: TSchema,
	label: string,
	source: Record<string, string | undefined> = process.env,
): z.output<TSchema> => {
	const result = schema.safeParse(source);

	if (!result.success) {
		throw new Error(
			`${label} environment validation failed:\n${z.prettifyError(result.error)}`,
		);
	}

	return result.data;
};
