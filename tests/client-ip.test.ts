import { describe, expect, test } from "bun:test";

import { getClientIp } from "../src/packages/utils/client-ip";

const req = (headers: Record<string, string>) => new Request("http://localhost/", { headers });

describe("getClientIp", () => {
	test("ignores forged forwarding headers unless a proxy is trusted", () => {
		const forged = req({ "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "7.7.7.7" });
		expect(getClientIp(forged, "10.0.0.5", "none")).toBe("10.0.0.5");
	});

	test("falls back to 'unknown' with no socket and no trusted header", () => {
		expect(getClientIp(req({}), undefined, "none")).toBe("unknown");
	});

	test("cloudflare mode reads cf-connecting-ip only", () => {
		const request = req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" });
		expect(getClientIp(request, "10.0.0.5", "cloudflare")).toBe("1.2.3.4");
	});

	test("vercel mode prefers the platform header, then x-real-ip, then the first forwarded entry", () => {
		expect(
			getClientIp(
				req({ "x-vercel-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }),
				undefined,
				"vercel",
			),
		).toBe("1.1.1.1");
		expect(getClientIp(req({ "x-real-ip": "2.2.2.2" }), undefined, "vercel")).toBe("2.2.2.2");
		expect(
			getClientIp(req({ "x-forwarded-for": "3.3.3.3, 10.0.0.1" }), undefined, "vercel"),
		).toBe("3.3.3.3");
	});

	test("forwarded mode takes the rightmost entry, which the client cannot spoof", () => {
		const request = req({ "x-forwarded-for": "6.6.6.6, 8.8.8.8" });
		expect(getClientIp(request, "10.0.0.5", "forwarded")).toBe("8.8.8.8");
	});

	test("rejects malformed header values and uses the socket instead", () => {
		const request = req({ "cf-connecting-ip": "not-an-ip" });
		expect(getClientIp(request, "10.0.0.5", "cloudflare")).toBe("10.0.0.5");
	});

	test("understands IPv6", () => {
		const request = req({ "cf-connecting-ip": "2001:db8::1" });
		expect(getClientIp(request, undefined, "cloudflare")).toBe("2001:db8::1");
	});
});
