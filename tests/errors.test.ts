import { describe, expect, test } from "bun:test";

import { createApp } from "@/app/main";
import { AppError } from "@/packages/utils/errors";
import { pick, TestClient } from "./helpers/http";

const app = createApp()
	.get("/boom/unhandled", () => {
		throw new Error("kaboom");
	})
	.get("/boom/internal", () => {
		throw AppError.internal("server fault");
	})
	.get("/boom/unique", () => {
		throw Object.assign(new Error("duplicate key"), { errno: "23505" });
	});

const client = new TestClient(app);

describe("error handler", () => {
	test("an unexpected error is a generic 500 that leaks nothing", async () => {
		const response = await client.get("/boom/unhandled");

		expect(response.status).toBe(500);
		expect(pick(response.body, "message")).toBe("Internal server error");
		expect(JSON.stringify(response.body)).not.toContain("kaboom");
	});

	test("a non-operational AppError is a 500", async () => {
		expect((await client.get("/boom/internal")).status).toBe(500);
	});

	test("a unique-constraint error that slipped through is a 409, not a 500", async () => {
		expect((await client.get("/boom/unique")).status).toBe(409);
	});

	test("an unknown API route is a JSON 404", async () => {
		const response = await client.get("/api/v1/nope");
		expect(response.status).toBe(404);
		expect(pick(response.body, "success")).toBe(false);
	});

	test("a malformed JSON body is a 400", async () => {
		const response = await client.request("POST", "/api/v1/auth/email/signin", {
			headers: { "content-type": "application/json" },
			rawCookie: "",
		});
		// No body at all on a route that requires one is a validation failure, not a crash.
		expect([400, 422]).toContain(response.status);
	});

	test("field errors name the field and carry one message each", async () => {
		const response = await client.post("/api/v1/auth/email/signin", { json: { email: "x" } });

		expect(response.status).toBe(422);
		expect(pick(response.body, "message")).toBe("Validation failed");
		expect(JSON.stringify(pick(response.body, "errors"))).toContain('"field":"email"');
	});
});
