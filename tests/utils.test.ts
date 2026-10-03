import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { parseAuthEnv } from "@/packages/env/auth.env";
import { parseDurationSeconds } from "@/packages/env/duration";
import {
	generateOpaqueToken,
	hashOpaqueToken,
	hashPassword,
	signAccessToken,
	signRefreshToken,
	verifyAccessToken,
	verifyAgainstDummyHash,
	verifyPassword,
	verifyRefreshToken,
} from "@/packages/utils/auth";
import { isUniqueViolation } from "@/packages/utils/db-errors";
import { clampUserAgent, parseUserAgent } from "@/packages/utils/user-agent";

const CLAIMS = { userId: "u1", email: "a@b.com", role: "USER", sessionId: "s1" };

describe("parseDurationSeconds", () => {
	test("parses s/m/h/d and rejects everything else", () => {
		expect(parseDurationSeconds("30s")).toBe(30);
		expect(parseDurationSeconds("15m")).toBe(900);
		expect(parseDurationSeconds("12h")).toBe(43_200);
		expect(parseDurationSeconds("30D")).toBe(2_592_000);
		for (const bad of ["", "15", "m", "1.5h", "15 minutes", "-5m", "5w"]) {
			expect(parseDurationSeconds(bad)).toBeUndefined();
		}
	});
});

describe("auth env", () => {
	test("has working development defaults", () => {
		const env = parseAuthEnv({});
		expect(env.AUTH_ACCESS_TOKEN_TTL).toBe(900);
		expect(env.AUTH_REFRESH_TOKEN_TTL).toBe(2_592_000);
		expect(env.AUTH_SHORT_SESSION_TTL).toBe(86_400);
	});

	test("production refuses missing, short, default or identical secrets", () => {
		expect(() => parseAuthEnv({ NODE_ENV: "production" })).toThrow(/AUTH_ACCESS_TOKEN_SECRET/);
		expect(() =>
			parseAuthEnv({
				NODE_ENV: "production",
				AUTH_ACCESS_TOKEN_SECRET: "short",
				AUTH_REFRESH_TOKEN_SECRET: "short",
			}),
		).toThrow();

		const same = "x".repeat(40);
		expect(() =>
			parseAuthEnv({
				NODE_ENV: "production",
				AUTH_ACCESS_TOKEN_SECRET: same,
				AUTH_REFRESH_TOKEN_SECRET: same,
			}),
		).toThrow(/must differ/);

		expect(
			parseAuthEnv({
				NODE_ENV: "production",
				AUTH_ACCESS_TOKEN_SECRET: "a".repeat(40),
				AUTH_REFRESH_TOKEN_SECRET: "b".repeat(40),
			}).NODE_ENV,
		).toBe("production");
	});

	test("rejects a malformed TTL with a readable message", () => {
		expect(() => parseAuthEnv({ AUTH_ACCESS_TOKEN_TTL: "15 minutes" })).toThrow(
			/30s, 15m, 12h or 30d/,
		);
	});
});

describe("tokens", () => {
	test("access token round-trips", async () => {
		expect(await verifyAccessToken(await signAccessToken(CLAIMS))).toEqual(CLAIMS);
	});

	test("refresh token round-trips with its rotation id", async () => {
		const token = await signRefreshToken(
			{ userId: "u1", sessionId: "s1", tokenId: "t1" },
			new Date(Date.now() + 60_000),
		);
		expect(await verifyRefreshToken(token)).toEqual({
			userId: "u1",
			sessionId: "s1",
			tokenId: "t1",
		});
	});

	test("an access token is not a refresh token and vice versa", async () => {
		const access = await signAccessToken(CLAIMS);
		const refresh = await signRefreshToken(
			{ userId: "u1", sessionId: "s1", tokenId: "t1" },
			new Date(Date.now() + 60_000),
		);

		await expect(verifyRefreshToken(access)).rejects.toThrow();
		await expect(verifyAccessToken(refresh)).rejects.toThrow();
	});

	test("expired tokens are rejected", async () => {
		const expired = await signAccessToken(CLAIMS, -10);
		await expect(verifyAccessToken(expired)).rejects.toThrow(/expired/i);

		const lapsed = await signRefreshToken(
			{ userId: "u1", sessionId: "s1", tokenId: "t1" },
			new Date(Date.now() - 5_000),
		);
		await expect(verifyRefreshToken(lapsed)).rejects.toThrow();
	});

	test("tokens signed with another key, tampered, or unsigned are rejected", async () => {
		const foreign = await new SignJWT({ email: "a@b.com", sid: "s1", typ: "access" })
			.setProtectedHeader({ alg: "HS256" })
			.setSubject("u1")
			.setIssuer("cloak-shield")
			.setAudience("cloak-shield-api")
			.setExpirationTime("5m")
			.sign(new TextEncoder().encode("some-other-secret-that-is-long-enough"));
		await expect(verifyAccessToken(foreign)).rejects.toThrow();

		const good = await signAccessToken(CLAIMS);
		await expect(verifyAccessToken(`${good.slice(0, -4)}AAAA`)).rejects.toThrow();

		const unsigned = `${btoa('{"alg":"none"}')}.${btoa('{"sub":"u1","typ":"access"}')}.`;
		await expect(verifyAccessToken(unsigned)).rejects.toThrow();
		await expect(verifyAccessToken("garbage")).rejects.toThrow();
	});

	test("wrong issuer or audience is rejected", async () => {
		const key = new TextEncoder().encode(parseAuthEnv({}).AUTH_ACCESS_TOKEN_SECRET);
		const wrong = await new SignJWT({ email: "a@b.com", sid: "s1", typ: "access" })
			.setProtectedHeader({ alg: "HS256" })
			.setSubject("u1")
			.setIssuer("someone-else")
			.setAudience("cloak-shield-api")
			.setExpirationTime("5m")
			.sign(key);
		await expect(verifyAccessToken(wrong)).rejects.toThrow();
	});
});

describe("passwords and one-time tokens", () => {
	test("argon2id hash verifies only the right password", async () => {
		const hash = await hashPassword("Correct-Horse-9-Battery!");
		expect(hash).toStartWith("$argon2id$");
		expect(await verifyPassword("Correct-Horse-9-Battery!", hash)).toBe(true);
		expect(await verifyPassword("nope", hash)).toBe(false);
	});

	test("dummy verification resolves without throwing", async () => {
		await verifyAgainstDummyHash("anything");
	});

	test("opaque tokens are unique, url-safe, and stored only as a hash", () => {
		const a = generateOpaqueToken();
		expect(a).not.toBe(generateOpaqueToken());
		expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(hashOpaqueToken(a)).toMatch(/^[0-9a-f]{64}$/);
		expect(hashOpaqueToken(a)).not.toContain(a);
	});
});

describe("isUniqueViolation", () => {
	test("recognizes Postgres 23505 directly and through wrapped causes", () => {
		expect(isUniqueViolation({ errno: "23505" })).toBe(true);
		expect(isUniqueViolation({ code: "23505" })).toBe(true);
		expect(isUniqueViolation(new Error("wrapped", { cause: { errno: "23505" } }))).toBe(true);
	});

	test("ignores other errors", () => {
		expect(isUniqueViolation(new Error("boom"))).toBe(false);
		expect(isUniqueViolation({ errno: "23503" })).toBe(false);
		expect(isUniqueViolation(undefined)).toBe(false);
		expect(isUniqueViolation("23505")).toBe(false);
	});
});

describe("parseUserAgent", () => {
	test("detects common browsers and systems", () => {
		const cases: Array<[string, string]> = [
			[
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
				"Chrome on Windows",
			],
			[
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0",
				"Edge on Windows",
			],
			[
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
				"Safari on macOS",
			],
			[
				"Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
				"Firefox on Linux",
			],
			[
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
				"Safari on iOS",
			],
			[
				"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 OPR/80",
				"Opera on Android",
			],
		];

		for (const [agent, expected] of cases)
			expect(parseUserAgent(agent).deviceName).toBe(expected);
	});

	test("classifies the platform", () => {
		expect(
			parseUserAgent("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) Safari/604.1").platform,
		).toBe("tablet");
		expect(
			parseUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile Safari/537").platform,
		).toBe("mobile");
		expect(parseUserAgent("curl/8.0").platform).toBe("unknown");
	});

	test("never stores an unbounded user agent", () => {
		expect(clampUserAgent("x".repeat(5_000)).length).toBe(512);
		expect(clampUserAgent(null)).toBe("unknown");
		expect(parseUserAgent(undefined).deviceName).toBe("Unknown browser on Unknown OS");
	});
});
