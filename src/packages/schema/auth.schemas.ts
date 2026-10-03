import { z } from "zod";
import {
	booleanFlagRules,
	confirmPasswordRules,
	emailRules,
	emailTokenRules,
	fullnameRules,
	passwordRules,
	schemaMessages,
	signInPasswordRules,
} from "@/packages/configs/schemas.config";

// SCHEMA
export const signUpSchema = z
	.object({
		fullname: fullnameRules.optional(),
		email: emailRules,
		password: passwordRules,
	})
	.describe("Registration form");

export const signInSchema = z.object({
	email: emailRules,
	password: signInPasswordRules,
	remember: booleanFlagRules.optional(),
});

export const verifyEmailSchema = z.object({
	token: emailTokenRules,
});

export const resendVerificationSchema = z.object({
	email: emailRules,
});

export const forgotPasswordSchema = z.object({
	email: emailRules,
});

export const resetPasswordSchema = z
	.object({
		token: emailTokenRules,
		password: passwordRules,
		confirmPassword: confirmPasswordRules,
	})
	.refine((data) => data.password === data.confirmPassword, {
		message: schemaMessages.passwordMismatch,
		path: ["confirmPassword"],
	});

export const contactSchema = z.object({
	fullname: fullnameRules,
	email: emailRules,
	topic: z.string().trim().min(5, "Topic is required"),
	message: z.string().trim().min(5, "Message is required"),
	newsletter: booleanFlagRules.optional(),
});

//  SCHEMA OUTPUT
export type SignUpBody = z.infer<typeof signUpSchema>;

export type SignInBody = z.infer<typeof signInSchema>;

export type VerifyEmailBody = z.infer<typeof verifyEmailSchema>;

export type ResendVerificationBody = z.infer<typeof resendVerificationSchema>;

export type ForgotPasswordBody = z.infer<typeof forgotPasswordSchema>;

export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;

// ── Signed-in account security ────────────────────────────────────────────────

export const changePasswordBodySchema = z
	.object({
		currentPassword: signInPasswordRules,
		newPassword: passwordRules,
		confirmPassword: confirmPasswordRules,
	})
	.refine((data) => data.newPassword === data.confirmPassword, {
		message: schemaMessages.passwordMismatch,
		path: ["confirmPassword"],
	})
	.refine((data) => data.currentPassword !== data.newPassword, {
		message: "New password must be different from the current password",
		path: ["newPassword"],
	});

export const changeEmailSchema = z.object({
	newEmail: emailRules,
	// Re-authentication: a stolen session alone must not be able to take over the account.
	password: signInPasswordRules,
});

export const confirmEmailChangeSchema = z.object({
	token: emailTokenRules,
});

export const deleteAccountSchema = z.object({
	password: signInPasswordRules,
});

export const sessionParamsSchema = z.object({
	id: z.uuid(),
});

export const activityQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(20),
	// ISO timestamp of the oldest row already seen; returns older rows. A string (not a Date) so
	// the OpenAPI document can describe it; the service converts it.
	before: z.iso.datetime({ offset: true }).optional(),
});

export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;

export type ChangeEmailBody = z.infer<typeof changeEmailSchema>;

export type ConfirmEmailChangeBody = z.infer<typeof confirmEmailChangeSchema>;

export type DeleteAccountBody = z.infer<typeof deleteAccountSchema>;

export type ActivityQuery = z.infer<typeof activityQuerySchema>;
