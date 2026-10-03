import { SQL } from "bun";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";

import { envAppConfig } from "@/packages/env/app.env";
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
	// no TLS, which Supabase just silently closes the connection on. DATABASE_SSL=false is
	// for a local Postgres only.
	const client = new SQL(databaseUrl, { tls: envAppConfig.DATABASE_SSL });
	instance = drizzle({ client, schema });
	return instance;
};

// The client is created on first use so importing this module never needs DATABASE_URL (the
// app must be able to boot and answer /health without it). A Proxy over an empty object is the
// one deliberate widening here: the stand-in is typed as the real client and forwards every
// property access to it.
// type-coverage:ignore-next-line
export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
	get(_target, prop) {
		const real = getDb();
		return Reflect.get(real, prop, real);
	},
});
