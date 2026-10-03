import { z } from "zod";

import { UserGenderValues } from "@/packages/configs/gender.config";
import { fullnameRules, phoneRules, usernameRules } from "@/packages/configs/schemas.config";

const isTimeZone = (value: string): boolean => {
	try {
		new Intl.DateTimeFormat("en", { timeZone: value });
		return true;
	} catch {
		return false;
	}
};

const isLocale = (value: string): boolean => {
	try {
		return Intl.getCanonicalLocales(value).length === 1;
	} catch {
		return false;
	}
};

// https only: these URLs are rendered as links, and `javascript:` / `data:` must never get in.
const httpsUrl = z.url({ protocol: /^https$/, hostname: /^[^\s]+\.[^\s]+$/ }).max(2_048);

// PATCH semantics: leave a field out to keep it, send null to clear it.
const clearable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

export const updateProfileBodySchema = z
	.object({
		fullname: fullnameRules.optional(),
		avatarUrl: clearable(httpsUrl),
		username: clearable(usernameRules),
		bio: clearable(z.string().trim().max(500)),
		phone: clearable(phoneRules),
		// A plain "YYYY-MM-DD" string: Zod cannot describe a Date in JSON Schema, so a Date field
		// would make OpenAPI generation warn. The service turns it into a Date. Compared at request
		// time (not import time), so a long-running server never accepts tomorrow's date.
		birthDate: clearable(
			z.iso
				.date()
				.refine(
					(value) => value <= new Date().toISOString().slice(0, 10),
					"Birth date cannot be in the future",
				),
		),
		gender: clearable(z.enum(UserGenderValues)),
		timezone: clearable(z.string().trim().refine(isTimeZone, "Unknown time zone")),
		locale: clearable(z.string().trim().refine(isLocale, "Invalid locale, e.g. en-US")),
		website: clearable(httpsUrl),
		twitterUrl: clearable(httpsUrl),
		githubUrl: clearable(httpsUrl),
		linkedinUrl: clearable(httpsUrl),
	})
	.refine((data) => Object.keys(data).length > 0, "Send at least one field to update");

export const updatePreferencesBodySchema = z
	.object({
		theme: z.enum(["light", "dark", "system"]).optional(),
		language: z.string().trim().refine(isLocale, "Invalid language tag").optional(),
		emailNotifications: z.boolean().optional(),
		pushNotifications: z.boolean().optional(),
		marketingEmails: z.boolean().optional(),
		reducedMotion: z.boolean().optional(),
		highContrast: z.boolean().optional(),
	})
	.refine((data) => Object.keys(data).length > 0, "Send at least one field to update");

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;

export type UpdatePreferencesBody = z.infer<typeof updatePreferencesBodySchema>;
