export default {
	"*.{ts,tsx,js,cjs,mjs,json,jsonc}": ["biome check --write --no-errors-on-unmatched"],
	// A function ignores the staged file list, so tsc checks the whole project once.
	"*.ts": () => "tsc --noEmit",
	"package.json": ["sort-package-json"],
	"*": ["secretlint"],
};
