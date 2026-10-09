import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { DeviceInfo } from "../src/app/auth/core/auth.types";
import {
	type ExternalIdentity,
	resolveExternalIdentity,
} from "../src/app/auth/core/identity.service";
import type { OAuthProvider } from "../src/packages/configs/oauth-provider.config";
import { setAuthRepository } from "../src/packages/repository/drizzle/auth.repository";
import type { OAuthAccountRecord } from "../src/packages/schema/user.schema";
import { newEmail } from "./helpers/auth-flow";
import { InMemoryAuthRepository } from "./helpers/memory-repo";

// The racing tests in identity-flow fire simultaneous requests, which only hit a given
// ordering some of the time. These pin the orderings down: the repository is told to
// answer the FIRST identity lookup as "not linked yet" even though another request has since
// linked it, which is exactly what a request that loses a race observes.

const DEVICE: DeviceInfo = {
	deviceName: "Chrome on Windows",
	platform: "desktop",
	browser: "Chrome",
	os: "Windows",
	ipAddress: "203.0.113.9",
	userAgent: "test",
};

class StaleFirstLookup extends InMemoryAuthRepository {
	private served = false;

	override async findOAuthAccount(
		provider: OAuthProvider,
		providerUserId: string,
	): Promise<OAuthAccountRecord | undefined> {
		if (!this.served) {
			this.served = true;
			return undefined;
		}
		return super.findOAuthAccount(provider, providerUserId);
	}
}

describe("losing a race while resolving an identity", () => {
	const repo = new StaleFirstLookup();

	beforeAll(() => setAuthRepository(repo));
	afterAll(() => setAuthRepository(null));

	test("an identity linked a moment ago resolves to its account, not to provider_conflict", async () => {
		const identity: ExternalIdentity = {
			provider: "GOOGLE",
			providerUserId: `g-${crypto.randomUUID()}`,
			email: newEmail("race"),
			emailVerified: true,
			fullname: "Race User",
		};

		// The winner: creates the account and the link.
		const winner = await resolveExternalIdentity(identity, DEVICE);
		expect(winner.outcome).toBe("created");

		// The loser: its first lookup (served stale above) said "not linked", so it takes the email
		// path, finds the account, and finds the winner's link on it.
		const stale = new StaleFirstLookup();
		setAuthRepository(stale);
		await stale.createUserWithSession({
			user: winner.user,
			security:
				(await repo.getUserSecurity(winner.user.id)) ??
				(() => {
					throw new Error("security row missing");
				})(),
			profile:
				(await repo.getUserProfile(winner.user.id)) ??
				(() => {
					throw new Error("profile row missing");
				})(),
			preferences:
				(await repo.getUserPreferences(winner.user.id)) ??
				(() => {
					throw new Error("preferences row missing");
				})(),
			oauthAccount: {
				id: winner.oauthAccountId,
				userId: winner.user.id,
				provider: "GOOGLE",
				providerUserId: identity.providerUserId,
				createdAt: new Date(),
				lastLoginAt: new Date(),
			},
		});

		const loser = await resolveExternalIdentity(identity, DEVICE);

		expect(loser.outcome).toBe("existing");
		expect(loser.user.id).toBe(winner.user.id);
		expect((await stale.listOAuthAccountsForUser(winner.user.id)).length).toBe(1);
	});
});
