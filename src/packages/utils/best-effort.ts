import { logger } from "./logger";

/**
 * Runs a side effect (sending mail, writing an audit row) whose failure must never change the
 * caller's response: a visible failure for some requests but not others could leak which
 * accounts exist, and a sign-up should not fail because the mail provider hiccuped.
 */
export const bestEffort = async (label: string, task: () => Promise<void>): Promise<void> => {
	try {
		await task();
	} catch (error) {
		logger.error(`${label} failed`, {
			message: error instanceof Error ? error.message : String(error),
		});
	}
};
