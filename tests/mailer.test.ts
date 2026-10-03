import { describe, expect, test } from "bun:test";

import { parseMailEnv } from "@/packages/env/mail.env";
import { getMailer, setMailer } from "@/packages/mailer/mailer";
import { createResendMailer, type FetchLike } from "@/packages/mailer/resend";
import {
	accountDeletedTemplate,
	clientLink,
	emailChangedTemplate,
	emailChangeRequestedTemplate,
	maskEmail,
	newDeviceTemplate,
	passwordChangedTemplate,
} from "@/packages/mailer/templates";

interface Captured {
	url: string;
	init: RequestInit;
}

const recorder = (response: Response) => {
	const calls: Captured[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url, init });
		return response;
	};
	return { calls, fetchImpl };
};

const MESSAGE = { to: "ann@example.com", subject: "Hello", text: "Body with a link" };

describe("Resend transport", () => {
	test("posts one JSON request with the key in the Authorization header only", async () => {
		const { calls, fetchImpl } = recorder(new Response('{"id":"abc"}', { status: 200 }));
		const mailer = createResendMailer({
			apiKey: "re_secret_key",
			from: "Cloak <no-reply@example.com>",
			fetchImpl,
		});

		await mailer.send(MESSAGE);

		expect(calls.length).toBe(1);
		const [call] = calls;
		expect(call?.url).toBe("https://api.resend.com/emails");
		expect(call?.init.method).toBe("POST");

		const headers = new Headers(call?.init.headers);
		expect(headers.get("authorization")).toBe("Bearer re_secret_key");
		expect(headers.get("content-type")).toBe("application/json");

		const sent: unknown = JSON.parse(String(call?.init.body));
		expect(sent).toEqual({
			from: "Cloak <no-reply@example.com>",
			to: ["ann@example.com"],
			subject: "Hello",
			text: "Body with a link",
		});
		expect(String(call?.init.body)).not.toContain("re_secret_key");
		expect(call?.init.signal).toBeInstanceOf(AbortSignal);
	});

	test("a non-2xx answer throws with the status, and never echoes the key", async () => {
		const { fetchImpl } = recorder(
			new Response('{"message":"The from domain is not verified"}', { status: 403 }),
		);
		const mailer = createResendMailer({ apiKey: "re_secret_key", from: "a@b.co", fetchImpl });

		const failure = await mailer.send(MESSAGE).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(Error);
		const message = failure instanceof Error ? failure.message : "";
		expect(message).toContain("HTTP 403");
		expect(message).toContain("not verified");
		expect(message).not.toContain("re_secret_key");
	});

	test("a network failure propagates so the caller can log it", async () => {
		const mailer = createResendMailer({
			apiKey: "k",
			from: "a@b.co",
			fetchImpl: async () => {
				throw new Error("connect ECONNREFUSED");
			},
		});

		await expect(mailer.send(MESSAGE)).rejects.toThrow(/ECONNREFUSED/);
	});

	test("an unreadable error body still produces a useful error", async () => {
		const broken = new Response(null, { status: 502 });
		Object.defineProperty(broken, "text", {
			value: async () => {
				throw new Error("stream closed");
			},
		});
		const mailer = createResendMailer({
			apiKey: "k",
			from: "a@b.co",
			fetchImpl: async () => broken,
		});

		await expect(mailer.send(MESSAGE)).rejects.toThrow(/HTTP 502/);
	});
});

describe("mail env", () => {
	test("defaults are safe for development", () => {
		const env = parseMailEnv({});
		expect(env.MAIL_TRANSPORT).toBe("auto");
		expect(env.RESEND_API_KEY).toBeUndefined();
	});

	test("Resend needs both a key and a from address", () => {
		expect(() => parseMailEnv({ MAIL_TRANSPORT: "resend" })).toThrow(/RESEND_API_KEY/);
		expect(() => parseMailEnv({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: "k" })).toThrow(
			/MAIL_FROM/,
		);
		expect(() => parseMailEnv({ RESEND_API_KEY: "k" })).toThrow(/MAIL_FROM/);
		expect(
			parseMailEnv({
				MAIL_TRANSPORT: "resend",
				RESEND_API_KEY: "k",
				MAIL_FROM: "Cloak <no-reply@example.com>",
			}).MAIL_TRANSPORT,
		).toBe("resend");
	});

	test("the log transport is refused in production, where it would print live links", () => {
		expect(() => parseMailEnv({ NODE_ENV: "production", MAIL_TRANSPORT: "log" })).toThrow(
			/production log/,
		);
		expect(
			parseMailEnv({ NODE_ENV: "development", MAIL_TRANSPORT: "log" }).MAIL_TRANSPORT,
		).toBe("log");
	});

	test("custom lets you plug your own transport with no key", () => {
		expect(
			parseMailEnv({ NODE_ENV: "production", MAIL_TRANSPORT: "custom" }).MAIL_TRANSPORT,
		).toBe("custom");
	});
});

describe("mailer registry", () => {
	test("setMailer swaps the transport", async () => {
		const original = getMailer();
		const seen: string[] = [];

		setMailer({
			send: async (message) => {
				seen.push(message.to);
			},
		});
		await getMailer().send(MESSAGE);
		setMailer(original);

		expect(seen).toEqual(["ann@example.com"]);
		expect(getMailer()).toBe(original);
	});
});

describe("templates", () => {
	test("maskEmail keeps the first letter and the domain only", () => {
		expect(maskEmail("jane.doe@example.com")).toBe("j***@example.com");
		expect(maskEmail("x@y.io")).toBe("x***@y.io");
	});

	test("clientLink encodes the token and points at the frontend", () => {
		const link = clientLink("/verify-email", "a+b/c=d");
		expect(link).toContain("/verify-email?token=a%2Bb%2Fc%3Dd");
		expect(link.startsWith("http")).toBe(true);
	});

	test("email-change notices show only a masked new address", () => {
		for (const template of [
			emailChangeRequestedTemplate("jane.doe@example.com"),
			emailChangedTemplate("jane.doe@example.com"),
		]) {
			expect(template.text).toContain("j***@example.com");
			expect(template.text).not.toContain("jane.doe");
		}
	});

	test("device notices name the device, address and time", () => {
		const device = {
			deviceName: "Safari on iOS",
			ipAddress: "203.0.113.9",
			when: new Date("2026-10-03T12:00:00Z"),
		};

		for (const template of [passwordChangedTemplate(device), newDeviceTemplate(device)]) {
			expect(template.text).toContain("Safari on iOS");
			expect(template.text).toContain("203.0.113.9");
			expect(template.text).toContain("12:00:00 GMT");
		}
	});

	test("every notice tells the reader what to do if it was not them", () => {
		expect(
			newDeviceTemplate({ deviceName: "x", ipAddress: "y", when: new Date() }).text,
		).toMatch(/if not/i);
		expect(accountDeletedTemplate().text).toMatch(/did not do this/i);
	});
});
