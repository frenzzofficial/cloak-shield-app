import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
	throw new Error(
		"Missing DATABASE_URL. Set it in your .env file (Supabase Postgres connection string).",
	);
}

export default defineConfig({
	schema: "./src/packages/db/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		url: databaseUrl,
		// DATABASE_SSL=false is for a local Postgres only (hosted ones require TLS).
		ssl: process.env.DATABASE_SSL === "false" ? false : "require",
	},
});
