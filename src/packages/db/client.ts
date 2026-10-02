import { SQL } from "bun";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";

import * as schema from "./schema";

type DrizzleDb = BunSQLDatabase<typeof schema>;

let instance: DrizzleDb | null = null;

// Lazily created: neither the env check nor the SQL client is touched until
// the first actual query. This lets the app boot and serve routes that don't
// need the DB (e.g. /health) even if DATABASE_URL isn't set yet, and fail
// cleanly per-request instead of crashing the whole process at import time.
const getDb = (): DrizzleDb => {
	if (instance) return instance;

	const databaseUrl = process.env.DATABASE_URL;

	if (!databaseUrl) {
		throw new Error(
			"Missing DATABASE_URL. Set it to your Supabase Postgres connection string " +
				"(Dashboard > Settings > Database > Connection string > URI).",
		);
	}

	// Supabase requires TLS on every connection; Bun's SQL client defaults to
	// no TLS, which Supabase just silently closes the connection on.
	const client = new SQL(databaseUrl, { tls: true });
	instance = drizzle({ client, schema });
	return instance;
};

export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
	get(_target, prop, receiver) {
		return Reflect.get(getDb() as object, prop, receiver);
	},
});
