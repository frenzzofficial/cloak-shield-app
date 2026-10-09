import { describe, expect, test } from "bun:test";

import {
	contactSchema,
	resetPasswordSchema,
	signInSchema,
	signUpSchema,
} from "../src/packages/schema/auth.schemas";

const base = { email: "ann@example.com", password: "Correct-Horse-9-Battery!" };

describe("signUpSchema", () => {
	test("normalizes the email before validating it", () => {
		const parsed = signUpSchema.parse({ ...base, email: "  ANN@Example.COM  " });
		expect(parsed.email).toBe("ann@example.com");
	});

	test("accepts names in any script, rejects digits and symbols", () => {
		for (const fullname of ["Ánna Müller", "李小龙", "O'Brien-Smith", "Dr. Who"]) {
			expect(signUpSchema.safeParse({ ...base, fullname }).success).toBe(true);
		}
		for (const fullname of ["R2D2", "A", "<script>"]) {
			expect(signUpSchema.safeParse({ ...base, fullname }).success).toBe(false);
		}
	});

	test("password: 8-128 chars, mixed, no spaces, and never silently trimmed", () => {
		expect(
			signUpSchema.safeParse({ ...base, password: `Aa1!${"x".repeat(124)}` }).success,
		).toBe(true);
		expect(
			signUpSchema.safeParse({ ...base, password: `Aa1!${"x".repeat(125)}` }).success,
		).toBe(false);
		expect(signUpSchema.safeParse({ ...base, password: "Aa1!xyz" }).success).toBe(false);
		expect(
			signUpSchema.safeParse({ ...base, password: "Correct-Horse-9-Battery! " }).success,
		).toBe(false);
	});

	test("blocks throwaway email domains", () => {
		expect(signUpSchema.safeParse({ ...base, email: "x@mailinator.com" }).success).toBe(false);
	});
});

describe("signInSchema", () => {
	test("applies no complexity rules", () => {
		expect(signInSchema.safeParse({ ...base, password: "x" }).success).toBe(true);
		expect(signInSchema.safeParse({ ...base, password: "" }).success).toBe(false);
	});

	test('"false" means false (z.coerce.boolean would say true)', () => {
		const flag = (remember: unknown) => signInSchema.parse({ ...base, remember }).remember;

		expect(flag("false")).toBe(false);
		expect(flag("true")).toBe(true);
		expect(flag(false)).toBe(false);
		expect(flag(true)).toBe(true);
		expect(flag("0")).toBe(false);
		expect(signInSchema.safeParse({ ...base, remember: "banana" }).success).toBe(false);
	});
});

describe("resetPasswordSchema", () => {
	const token = "t".repeat(43);

	test("requires matching confirmation and reports it on confirmPassword", () => {
		const result = resetPasswordSchema.safeParse({
			token,
			password: "Correct-Horse-9-Battery!",
			confirmPassword: "Different-Guess-2!",
		});

		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["confirmPassword"]);
		expect(
			resetPasswordSchema.safeParse({
				token,
				password: "Correct-Horse-9-Battery!",
				confirmPassword: "Correct-Horse-9-Battery!",
			}).success,
		).toBe(true);
	});
});

describe("contactSchema", () => {
	test('newsletter "false" is false', () => {
		const parsed = contactSchema.parse({
			fullname: "Ann Lee",
			email: "ann@example.com",
			topic: "Hello there",
			message: "A message",
			newsletter: "false",
		});
		expect(parsed.newsletter).toBe(false);
	});
});
