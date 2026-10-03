import { describe, expect, spyOn, test } from "bun:test";

import { createApp } from "@/app/main";
import { pick, TestClient } from "./helpers/http";

const client = new TestClient(createApp());

describe("app smoke", () => {
	test("health endpoints answer", async () => {
		for (const path of ["/health", "/api/health"]) {
			const response = await client.get(path);
			expect([200, 503]).toContain(response.status);
			expect(pick(response.body, "data.status")).toBeDefined();
		}
	});

	test("static pages are served as HTML", async () => {
		for (const path of ["/", "/home", "/docs"]) {
			const response = await client.get(path);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/html");
		}
	});

	test("an unknown asset is a real 404 (not a 200 with an error page)", async () => {
		const response = await client.get("/assets/does-not-exist.png");
		expect(response.status).toBe(404);
	});

	test("the OpenAPI document builds and lists the auth routes with their schemas", async () => {
		const response = await client.get("/openapi/json");

		expect(response.status).toBe(200);
		for (const path of [
			"signup",
			"signin",
			"refresh",
			"signout",
			"forgot-password",
			"reset-password",
		]) {
			expect(pick(response.body, `paths./api/v1/auth/email/${path}`)).toBeDefined();
		}

		// The email rule uses trim -> lowercase -> pipe(email); it must still document as a string.
		const email = pick(
			response.body,
			"paths./api/v1/auth/email/signin.post.requestBody.content.application/json.schema.properties.email",
		);
		expect(pick(email, "type")).toBe("string");
	});

	test("the OpenAPI document builds without schema warnings", async () => {
		// Zod cannot describe a Date in JSON Schema; a Date field in a route schema logs
		// "Date cannot be represented in JSON Schema" every time the docs are generated.
		const warnings: string[] = [];
		const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});

		try {
			const response = await new TestClient(createApp()).get("/openapi/json");
			expect(response.status).toBe(200);
		} finally {
			warn.mockRestore();
		}

		expect(warnings).toEqual([]);
	});

	test("security headers are present", async () => {
		const response = await client.get("/health");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});
});
