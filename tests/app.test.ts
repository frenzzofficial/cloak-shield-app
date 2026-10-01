import { describe, expect, test } from "bun:test";

import { createApp } from "../src/app/main";
import { AppError } from "../src/packages/utils/errors";

const app = createApp().get("/boom", () => {
	throw AppError.forbidden("nope");
});

const call = (path: string): Promise<Response> =>
	app.handle(new Request(`http://localhost${path}`));

describe("app", () => {
	test("AppError maps to its status code", async () => {
		const response = await call("/boom");

		expect(response.status).toBe(403);
		expect(response.headers.get("content-type")).toContain("application/json");

		expect(await response.json()).toEqual({
			success: false,
			message: "nope",
		});
	});
});
