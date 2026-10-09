import { envAppConfig } from "../env/app.env";

type LogLevel = "error" | "warn" | "info" | "debug";

const WEIGHT: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
	if (WEIGHT[level] > WEIGHT[envAppConfig.LOG_LEVEL]) return;

	const line = `${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`;

	// stderr for problems, stdout for the rest. Vercel captures both streams.
	if (level === "error" || level === "warn") {
		process.stderr.write(line);
		return;
	}
	process.stdout.write(line);
};

export const logger = {
	error: (message: string, fields?: Record<string, unknown>): void =>
		write("error", message, fields),
	warn: (message: string, fields?: Record<string, unknown>): void =>
		write("warn", message, fields),
	info: (message: string, fields?: Record<string, unknown>): void =>
		write("info", message, fields),
	debug: (message: string, fields?: Record<string, unknown>): void =>
		write("debug", message, fields),
};
