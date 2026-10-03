import { z } from "zod";

const UNIT_SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;

type DurationUnit = keyof typeof UNIT_SECONDS;

const isDurationUnit = (value: string): value is DurationUnit => value in UNIT_SECONDS;

/** "15m" -> 900, "30d" -> 2592000. Only whole numbers with an s/m/h/d suffix are accepted. */
export const parseDurationSeconds = (value: string): number | undefined => {
	const match = /^(\d+)([smhd])$/i.exec(value.trim());
	if (!match) return undefined;

	const [, amount, rawUnit] = match;
	const unit = rawUnit?.toLowerCase();
	if (amount === undefined || unit === undefined || !isDurationUnit(unit)) return undefined;

	return Number(amount) * UNIT_SECONDS[unit];
};

/** Zod field for env durations such as AUTH_ACCESS_TOKEN_TTL=15m. Output is in seconds. */
export const durationSeconds = (label: string) =>
	z
		.string()
		.trim()
		.transform((value, ctx) => {
			const seconds = parseDurationSeconds(value);
			if (seconds === undefined || seconds <= 0) {
				ctx.addIssue({
					code: "custom",
					message: `${label} must look like 30s, 15m, 12h or 30d`,
				});
				return z.NEVER;
			}
			return seconds;
		});
