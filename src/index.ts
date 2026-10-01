// Vercel entrypoint. Vercel's zero-config Elysia detection needs a file at src/index.ts that
// imports the `elysia` package AND default-exports the app. `app.listen` is not supported there.
// See: https://vercel.com/docs/frameworks/backend/elysia
import { Elysia } from "elysia";

// `createApp` is imported dynamically (with a RELATIVE path, not the `@/` alias — see below)
// and wrapped in try/catch so that a bad environment variable (a typo, a too-short
// APP_SECRET, a non-numeric PORT, ...) returns a normal JSON 500 response instead of
// crashing the whole Bun process. A crashed process shows up in Vercel as an opaque
// "FUNCTION_INVOCATION_FAILED" with no usable message; this makes the real problem visible
// in the response body and in the logs.
//
// The `@/*` alias is a TypeScript compiler / bundler feature (see tsconfig.json), not a
// real Node/Bun module resolution feature. Vercel's build step rewrites `@/`-alias
// specifiers inside STATIC `import` statements (like the one two lines up), but a runtime
// specifier inside a DYNAMIC `import()` call is left as-is and resolved by the runtime
// directly — which does not know what "@" means, so `import("@/app/main")` fails in
// production with "Cannot find module '@/app/main'" even though it works locally under
// `bun run`, which does understand tsconfig paths. A relative path always resolves.
const buildApp = async (): Promise<Elysia> => {
	try {
		const { createApp } = await import("./app/main");
		// The two branches build structurally different Elysia instances (different routes,
		// no shared generic shape), so returning `Elysia` requires one deliberate, visible
		// widening cast through `unknown` rather than an `any`.
		const realApp = new Elysia({ name: "vercel-entry" }).use(createApp());
		// type-coverage:ignore-next-line
		return realApp as unknown as Elysia;
	} catch (thrown: unknown) {
		const message = thrown instanceof Error ? thrown.message : String(thrown);

		// biome-ignore lint/suspicious/noConsole: startup failure must reach Vercel's function logs
		console.error("[startup failed]", message);

		const errorApp = new Elysia({ name: "vercel-entry-startup-error" }).all("*", ({ set }) => {
			set.status = 500;
			return { success: false, message: "Server failed to start", error: message };
		});
		return errorApp as unknown as Elysia;
	}
};

const app = await buildApp();

export default app;
