const UNIQUE_VIOLATION = "23505";

const readString = (source: unknown, key: string): string | undefined => {
	if (typeof source !== "object" || source === null || !(key in source)) return undefined;
	const value: unknown = Reflect.get(source, key);
	return typeof value === "string" ? value : undefined;
};

/**
 * True when a Postgres unique constraint rejected the write (SQLSTATE 23505).
 * Drizzle wraps driver errors, so this walks the `cause` chain.
 */
export const isUniqueViolation = (error: unknown): boolean => {
	let current: unknown = error;

	for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
		if (
			readString(current, "errno") === UNIQUE_VIOLATION ||
			readString(current, "code") === UNIQUE_VIOLATION
		) {
			return true;
		}
		current = typeof current === "object" ? Reflect.get(current, "cause") : undefined;
	}

	return false;
};
