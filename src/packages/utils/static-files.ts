import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

// Project root (current working directory)
// e.g. /var/task on Vercel
const STATIC_ROOT = join(process.cwd(), "src", "assets");

const cache = new Map<string, Buffer>();

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
};

const getContentType = (path: string): string =>
	MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

export interface StaticAsset {
	body: Buffer;
	contentType: string;
}

export const getStaticAsset = async (path: string): Promise<StaticAsset | undefined> => {
	const cached = cache.get(path);

	if (cached) {
		return {
			body: cached,
			contentType: getContentType(path),
		};
	}

	try {
		const body = await readFile(join(STATIC_ROOT, path));

		cache.set(path, body);

		return {
			body,
			contentType: getContentType(path),
		};
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return undefined;
		}

		throw error;
	}
};

export const getHTML = async (path: string): Promise<string | undefined> => {
	const asset = await getStaticAsset(path);

	return asset?.body.toString("utf8");
};
