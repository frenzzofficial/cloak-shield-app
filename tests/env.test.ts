import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseEnv } from "../src/packages/utils/parse-env";

const schema = z.object({
	ENABLE_FEATURE: z.stringbool().default(true),
	PORT: z.coerce.number().default(7164),
});

describe("parseEnv", () => {
	test('treats the string "false" as false', () => {
		expect(parseEnv(schema, "Test", { ENABLE_FEATURE: "false" }).ENABLE_FEATURE).toBe(false);
	});

	test("applies defaults", () => {
		expect(parseEnv(schema, "Test", {})).toEqual({ ENABLE_FEATURE: true, PORT: 7164 });
	});

	test("reports which variable is invalid", () => {
		expect(() => parseEnv(schema, "Test", { ENABLE_FEATURE: "maybe" })).toThrow(
			/ENABLE_FEATURE/,
		);
	});
});
