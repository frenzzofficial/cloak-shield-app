import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { registerCompression } from "../src/packages/middlewares/compression";

// Over the 1 KB threshold, so these responses are actually compressed.
const BIG = { items: Array.from({ length: 60 }, (_, i) => ({ id: i, label: `item number ${i}` })) };

const app = new Elysia();
registerCompression(app);
app.get("/plain", () => BIG)
	.get("/status-200", ({ status }) => status(200, BIG))
	.get("/status-201", ({ status }) => status(201, BIG))
	.get("/small", ({ status }) => status(200, { ok: true }));

const request = (path: string, acceptEncoding?: string) =>
	app.handle(
		new Request(`http://localhost${path}`, {
			headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
		}),
	);

const gunzipJson = async (response: Response): Promise<unknown> =>
	JSON.parse(
		new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()))),
	);

describe("response compression", () => {
	test("compresses a large plain response and the body is unchanged", async () => {
		const res = await request("/plain", "gzip");
		expect(res.headers.get("content-encoding")).toBe("gzip");
		expect(await gunzipJson(res)).toEqual(BIG);
	});

	// Regression: the client received {"code":200,"response":{...}} instead of the body.
	test("compresses status(200, body) as the body, not Elysia's { code, response } wrapper", async () => {
		const res = await request("/status-200", "gzip");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-encoding")).toBe("gzip");
		expect(await gunzipJson(res)).toEqual(BIG);
	});

	test("keeps the status code chosen by status(...)", async () => {
		const res = await request("/status-201", "gzip");
		expect(res.status).toBe(201);
		expect(await gunzipJson(res)).toEqual(BIG);
	});

	test("leaves small responses and clients without gzip alone", async () => {
		const small = await request("/small", "gzip");
		expect(small.headers.get("content-encoding")).toBeNull();
		expect(await small.json()).toEqual({ ok: true });

		const plainClient = await request("/status-200");
		expect(plainClient.headers.get("content-encoding")).toBeNull();
		expect(await plainClient.json()).toEqual(BIG);
	});
});
