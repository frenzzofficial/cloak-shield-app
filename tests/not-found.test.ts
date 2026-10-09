import { describe, expect, test } from "bun:test";

import { createApp } from "../src/app/main";
import { pick, TestClient } from "./helpers/http";

const client = new TestClient(createApp());

const isJson = (contentType: string | null): boolean =>
	(contentType ?? "").includes("application/json");
const isHtml = (contentType: string | null): boolean => (contentType ?? "").includes("text/html");

describe("not found", () => {
	describe("under the API prefix: JSON", () => {
		test("an unknown API route is a JSON 404 that names the route", async () => {
			const response = await client.get("/api/v1/does-not-exist");

			expect(response.status).toBe(404);
			expect(isJson(response.headers.get("content-type"))).toBe(true);
			expect(pick(response.body, "success")).toBe(false);
			expect(pick(response.body, "message")).toBe(
				"Route not found: GET /api/v1/does-not-exist",
			);
		});

		test("the bare prefix and other versions are API 404s too", async () => {
			for (const path of ["/api", "/api/v2/anything", "/api/v1/auth/email/nope"]) {
				const response = await client.get(path);
				expect(`${path} -> ${response.status}`).toBe(`${path} -> 404`);
				expect(isJson(response.headers.get("content-type"))).toBe(true);
			}
		});

		test("the method is part of the message", async () => {
			const response = await client.request("DELETE", "/api/v1/does-not-exist");

			expect(response.status).toBe(404);
			expect(pick(response.body, "message")).toBe(
				"Route not found: DELETE /api/v1/does-not-exist",
			);
		});

		test("a real route with the wrong method is still handled, not swallowed", async () => {
			// GET on a POST-only auth route: the wildcard answers, with the method in the message.
			const response = await client.get("/api/v1/auth/email/signin");

			expect(response.status).toBe(404);
			expect(pick(response.body, "message")).toBe(
				"Route not found: GET /api/v1/auth/email/signin",
			);
		});
	});

	describe("everywhere else: the HTML page", () => {
		test("an unknown page is an HTML 404, and the status really is 404", async () => {
			const response = await client.get("/this-page-does-not-exist");

			// The status matters: a 404 page served with 200 is a "soft 404" that search engines
			// index and monitoring never notices.
			expect(response.status).toBe(404);
			expect(isHtml(response.headers.get("content-type"))).toBe(true);
			expect(String(response.body)).toContain("Nothing lives here");
		});

		test("the old unversioned auth path is the HTML page, not an API response", async () => {
			const response = await client.get("/auth/email/me");

			expect(response.status).toBe(404);
			expect(isHtml(response.headers.get("content-type"))).toBe(true);
		});

		test("a path that merely starts with the prefix letters is not the API", async () => {
			// "/apis" and "/api-docs" begin with "/api" but are not inside it.
			for (const path of ["/apis", "/api-docs", "/apiary/v1"]) {
				const response = await client.get(path);
				expect(`${path} -> ${response.status}`).toBe(`${path} -> 404`);
				expect(isHtml(response.headers.get("content-type"))).toBe(true);
			}
		});

		test("path traversal attempts are a plain 404, never a file", async () => {
			const up = encodeURIComponent("../");
			const attempts = [
				`/${up}${up}${up}${encodeURIComponent("etc/passwd")}`,
				`/${encodeURIComponent("..")}/package.json`,
				"/assets/../../package.json",
			];

			for (const path of attempts) {
				const response = await client.get(path);
				expect(response.status).toBe(404);
				expect(String(response.body)).not.toContain("root:");
				expect(String(response.body)).not.toContain('"scripts"');
			}
		});

		test("the 404 page does not echo the requested path (no reflected content)", async () => {
			const response = await client.get("/<script>alert(1)</script>");

			expect(response.status).toBe(404);
			expect(String(response.body)).not.toContain("alert(1)");
		});
	});

	test("known pages and routes are untouched by the catch-all", async () => {
		expect((await client.get("/")).status).toBe(200);
		expect((await client.get("/health")).status).toBeLessThan(600);
		expect((await client.get("/api/v1/auth/email/me")).status).toBe(401);
	});
});
