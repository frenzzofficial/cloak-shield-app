import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { emailPlugin } from "@/app/auth/email/email.plugin";
import { createGooglePlugin } from "@/app/auth/google/google.plugin";
import { createApp } from "@/app/main";
import type { OAuthProvider } from "@/packages/configs/oauth-provider.config";
import { setAuthRepository } from "@/packages/repository/drizzle/auth.repository";
import type { OAuthAccountRecord } from "@/packages/schema/user.schema";
import { newEmail } from "./helpers/auth-flow";
import { FakeGoogle } from "./helpers/fake-google";
import { TestClient } from "./helpers/http";
import { InMemoryAuthRepository } from "./helpers/memory-repo";

// Our own side failing in the middle of a sign-in (here: the database goes away). The user must
// still land back on the frontend with a code it can show, nothing about the failure may leak
// into the URL, and no session may be opened.
class DatabaseDown extends InMemoryAuthRepository {
	override async findOAuthAccount(
		_provider: OAuthProvider,
		_providerUserId: string,
	): Promise<OAuthAccountRecord | undefined> {
		throw new Error("connection to server at db.internal:5432 refused");
	}
}

describe("a crash on our side during a Google sign-in", () => {
	const repo = new DatabaseDown();
	let result: URL;
	let cookies: string[];
	let client: TestClient;

	beforeAll(async () => {
		setAuthRepository(repo);
		const google = await FakeGoogle.create();
		const app = createApp({
			authPlugins: [
				emailPlugin,
				createGooglePlugin({
					enabled: true,
					clientId: google.clientId,
					clientSecret: google.clientSecret,
					apiPublicUrl: "https://api.example.test",
					fetchImpl: google.fetch,
					jwks: google.jwks,
				}),
			],
		});

		client = new TestClient(app);
		const start = await client.get("/api/v1/auth/google/start");
		const authorized = google.authorize(String(start.headers.get("location")), {
			sub: "g-1",
			email: newEmail("crash"),
			emailVerified: true,
		});
		const callback = await client.get(authorized.path);

		expect(callback.status).toBe(302);
		result = new URL(String(callback.headers.get("location")));
		cookies = callback.setCookies;
	});

	afterAll(() => setAuthRepository(null));

	test("lands on the frontend with a generic code, not on an error page", () => {
		expect(result.pathname).toBe("/auth/callback");
		expect(result.searchParams.get("status")).toBe("error");
		expect(result.searchParams.get("error")).toBe("server_error");
		expect([...result.searchParams.keys()].sort()).toEqual(["error", "status"]);
	});

	test("nothing about the failure reaches the browser", () => {
		const seen = [result.toString(), ...cookies].join("\n");

		expect(seen).not.toContain("db.internal");
		expect(seen).not.toContain("refused");
	});

	test("no session is opened, and the state is still spent", () => {
		expect(client.hasCookie("access_token")).toBe(false);
		expect(client.hasCookie("refresh_token")).toBe(false);
		expect(client.hasCookie("oauth_state_google")).toBe(false);
	});

	test("the failure is audited with its reason", () => {
		const rows = repo.allAuditLogs();

		expect(rows.some((row) => row.metadata.reason === "server_error")).toBe(true);
		expect(JSON.stringify(rows)).not.toContain("db.internal");
	});
});
