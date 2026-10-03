// Anything with Elysia's `handle` works, so tests can add extra routes to the real app.
interface App {
	handle(request: Request): Promise<Response> | Response;
}

interface StoredCookie {
	value: string;
	path: string;
}

export interface TestResponse {
	status: number;
	body: unknown;
	setCookies: string[];
	headers: Headers;
}

export interface RequestOptions {
	json?: unknown;
	headers?: Record<string, string>;
	bearer?: string;
	/** Skip the automatic CSRF header (to test that it is enforced). */
	noCsrf?: boolean;
	/** Send this exact Cookie header instead of the jar. */
	rawCookie?: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Reads `a.b.c` out of an unknown JSON value without any type assertions. */
export const pick = (value: unknown, path: string): unknown => {
	let current: unknown = value;
	for (const key of path.split(".")) {
		if (typeof current !== "object" || current === null || !(key in current)) return undefined;
		current = Reflect.get(current, key);
	}
	return current;
};

/** A tiny browser: keeps a cookie jar (honouring Path / Max-Age) and does the CSRF handshake. */
export class TestClient {
	private jar = new Map<string, StoredCookie>();
	private csrfToken: string | undefined;

	constructor(
		private readonly app: App,
		private readonly headersForAll: Record<string, string> = {},
	) {}

	cookie(name: string): string | undefined {
		return this.jar.get(name)?.value;
	}

	hasCookie(name: string): boolean {
		return this.jar.has(name);
	}

	/** Make the jar forget a cookie, like an expired browser cookie. */
	dropCookie(name: string): void {
		this.jar.delete(name);
	}

	setCookie(name: string, value: string, path = "/"): void {
		this.jar.set(name, { value, path });
	}

	private cookieHeaderFor(path: string): string {
		return [...this.jar.entries()]
			.filter(([, cookie]) => path.startsWith(cookie.path))
			.map(([name, cookie]) => `${name}=${cookie.value}`)
			.join("; ");
	}

	private absorb(response: Response): string[] {
		const setCookies = response.headers.getSetCookie();

		for (const line of setCookies) {
			const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
			const separator = pair.indexOf("=");
			const name = pair.slice(0, separator);
			const value = decodeURIComponent(pair.slice(separator + 1));
			const lowered = attributes.map((attribute) => attribute.toLowerCase());
			const path =
				attributes.find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
			const expired =
				value === "" ||
				lowered.includes("max-age=0") ||
				lowered.some((a) => a.startsWith("expires=thu, 01 jan 1970"));

			if (expired) this.jar.delete(name);
			else this.jar.set(name, { value, path });
		}

		return setCookies;
	}

	async request(
		method: string,
		path: string,
		options: RequestOptions = {},
	): Promise<TestResponse> {
		const headers: Record<string, string> = { ...this.headersForAll, ...options.headers };

		if (options.json !== undefined) headers["content-type"] = "application/json";
		if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;

		const needsCsrf = !SAFE_METHODS.has(method) && !options.bearer && !options.noCsrf;
		if (needsCsrf) {
			if (!this.csrfToken) await this.fetchCsrfToken();
			if (this.csrfToken) headers["x-csrf-token"] = this.csrfToken;
		}

		const cookieHeader = options.rawCookie ?? this.cookieHeaderFor(path);
		if (cookieHeader) headers.cookie = cookieHeader;

		const response = await this.app.handle(
			new Request(`http://localhost${path}`, {
				method,
				headers,
				body: options.json === undefined ? undefined : JSON.stringify(options.json),
			}),
		);

		const setCookies = this.absorb(response);
		const text = await response.text();
		let body: unknown = text;
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {
			// not JSON; keep the raw text
		}

		return { status: response.status, body, setCookies, headers: response.headers };
	}

	get(path: string, options?: RequestOptions): Promise<TestResponse> {
		return this.request("GET", path, options);
	}

	post(path: string, options?: RequestOptions): Promise<TestResponse> {
		return this.request("POST", path, options);
	}

	private async fetchCsrfToken(): Promise<void> {
		const response = await this.request("GET", "/api/v1/csrf");
		const token = pick(response.body, "csrfToken");
		if (typeof token === "string") this.csrfToken = token;
	}

	/** Forget the cached CSRF token (e.g. after dropping the csrf cookie). */
	resetCsrf(): void {
		this.csrfToken = undefined;
	}
}
