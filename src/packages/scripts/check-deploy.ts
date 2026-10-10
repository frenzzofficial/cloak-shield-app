// Emulates what Vercel runs: every file transpiled on its own (no bundling, no tsconfig
// `paths`), then booted from that output. `bun build` (build:check) bundles and resolves
// aliases, so it cannot catch an import the deployed runtime cannot resolve.
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const srcDir = resolve("src");
const outDir = await mkdtemp(join(tmpdir(), "deploy-check-"));
const transpiler = new Bun.Transpiler({ loader: "ts" });

for await (const file of new Bun.Glob("**/*.ts").scan(srcDir)) {
	if (file.endsWith(".d.ts") || file.startsWith("packages/scripts/")) continue;
	const js = transpiler.transformSync(await Bun.file(join(srcDir, file)).text());
	const dest = join(outDir, "src", file.replace(/\.ts$/, ".js"));
	await mkdir(dirname(dest), { recursive: true });
	await writeFile(dest, js);
}
await symlink(resolve("node_modules"), join(outDir, "node_modules"));
await writeFile(join(outDir, "package.json"), '{"type":"module"}');
await cp(resolve("src/packages/scripts/deploy-boot.mjs"), join(outDir, "boot.mjs"));

const proc = Bun.spawn(["bun", "boot.mjs"], {
	cwd: outDir,
	env: {
		...process.env,
		NODE_ENV: "test",
		APP_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
		DATABASE_URL: process.env.DATABASE_URL ?? "postgres://u:p@localhost:5432/db",
	},
	stdout: "inherit",
	stderr: "inherit",
});
const code = await proc.exited;
await rm(outDir, { recursive: true, force: true });
process.exit(code);
