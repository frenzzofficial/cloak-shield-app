// Runs inside the emulated deploy directory.
try {
	await import("./src/app/main.js");
	// biome-ignore lint/suspicious/noConsole: CI script output
	console.log("deploy check: every module resolves");
} catch (error) {
	// biome-ignore lint/suspicious/noConsole: CI script output
	console.error("deploy check FAILED:", error instanceof Error ? error.message : error);
	process.exit(1);
}
