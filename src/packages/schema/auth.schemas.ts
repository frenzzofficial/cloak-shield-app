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
