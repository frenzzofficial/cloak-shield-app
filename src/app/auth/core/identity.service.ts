import { z } from "zod";

import { AuditEvents } from "../../../packages/configs/audit.config";
import type { OAuthProvider } from "../../../packages/configs/oauth-provider.config";
import { fullnameRules } from "../../../packages/configs/schemas.config";
import { getAuthRepository } from "../../../packages/repository/drizzle/auth.repository";
import type { OAuthAccountRecord, User } from "../../../packages/schema/user.schema";
import { isUniqueViolation } from "../../../packages/utils/db-errors";
import { AppError } from "../../../packages/utils/errors";
import { newPreferences, newProfile, newSecurity } from "./account-defaults";
import { recordAudit } from "./audit.service";
import type { DeviceInfo } from "./auth.types";
import { isBlocked } from "./session.service";

// "Which account is this person?" for every provider sign-in. A provider plugin proves WHO the
// visitor is (it verified a token with Google, say) and hands that claim here; this decides which
// account it belongs to. The decision is the same for every provider, so it lives once, in core.
//
//   already linked        -> that account                       (matched by provider user id)
//   email is new          -> create an account
//   email, verified       -> link to the existing account
//   email, NOT verified   -> reclaim it, then link              (see reclaimAccount)
//   anything doubtful     -> refuse, with a typed reason

const repo = () => getAuthRepository();

/** What a provider tells us about the person who just authenticated. */
export interface ExternalIdentity {
	provider: OAuthProvider;
	/** The provider's stable subject id (Google `sub`, Discord user id). NOT the email. */
	providerUserId: string;
	email: string | null | undefined;
	/** Whether the PROVIDER says it verified that address. Unverified claims are never trusted. */
	emailVerified: boolean;
	fullname?: string | null | undefined;
	avatarUrl?: string | null | undefined;
}

export type IdentityOutcome = "existing" | "created" | "linked" | "reclaimed";

export interface ResolvedIdentity {
	user: User;
	outcome: IdentityOutcome;
	oauthAccountId: string;
}

export type RefusalReason =
	| "email_missing"
	| "email_unverified"
	| "account_blocked"
	| "provider_conflict";

const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
	email_missing: "This account has no email address, so it cannot be used to sign in",
	email_unverified: "The email address on this account has not been verified",
	account_blocked: "This account is no longer active",
	provider_conflict: "A different account from this provider is already linked to that email",
};

/** A sign-in the rules refuse. `reason` is stable, so a callback can map it to a fixed error code. */
export class IdentityRefusal extends AppError {
	readonly reason: RefusalReason;

	constructor(reason: RefusalReason) {
		super(REFUSAL_MESSAGES[reason], 403);
		this.name = "IdentityRefusal";
		this.reason = reason;
	}
}

// Provider-supplied profile data is untrusted input: apply the same rules as the sign-up form,
// and drop what does not pass rather than refusing the sign-in over a cosmetic field.
const safeFullname = (value: string | null | undefined): string | null => {
	const parsed = fullnameRules.safeParse(value);
	return parsed.success ? parsed.data : null;
};

// https only: the value is rendered as an image/link later.
const httpsUrl = z.url({ protocol: /^https$/ }).max(2_048);
const safeAvatar = (value: string | null | undefined): string | null => {
	const parsed = httpsUrl.safeParse(value);
	return parsed.success ? parsed.data : null;
};

const link = (userId: string, identity: ExternalIdentity, now: Date): OAuthAccountRecord => ({
	id: crypto.randomUUID(),
	userId,
	provider: identity.provider,
	providerUserId: identity.providerUserId,
	createdAt: now,
	lastLoginAt: now,
});

const createAccount = async (
	identity: ExternalIdentity,
	email: string,
	device: DeviceInfo,
): Promise<ResolvedIdentity> => {
	const now = new Date();
	const oauthAccount = link("", identity, now);

	const user = await repo().createUserWithSession({
		user: {
			id: crypto.randomUUID(),
			fullname: safeFullname(identity.fullname),
			email,
			avatarUrl: safeAvatar(identity.avatarUrl),
			role: "USER",
			// The provider vouched for the address, so there is nothing left to verify.
			status: "ACTIVE",
			emailVerifiedAt: now,
			createdAt: now,
			updatedAt: now,
		},
		security: newSecurity(null, now),
		profile: newProfile(now),
		preferences: newPreferences(now),
		oauthAccount,
	});

	await recordAudit({
		event: AuditEvents.SIGN_UP,
		userId: user.id,
		device,
		metadata: { provider: identity.provider },
	});

	return { user, outcome: "created", oauthAccountId: oauthAccount.id };
};

const resolveOnce = async (
	identity: ExternalIdentity,
	device: DeviceInfo,
): Promise<ResolvedIdentity> => {
	// 1. Already linked: trust the provider's stable id, not the email, which can change.
	const linked = await repo().findOAuthAccount(identity.provider, identity.providerUserId);

	if (linked) {
		const owner = await repo().findUserById(linked.userId);
		if (!owner) throw AppError.internal("A linked provider identity has no account");
		if (isBlocked(owner)) throw new IdentityRefusal("account_blocked");

		await repo().markOAuthLogin(linked.id, new Date());
		return { user: owner, outcome: "existing", oauthAccountId: linked.id };
	}

	// 2. First time we see this identity: the email is the only thing that can connect it to an
	// account, so it must exist and the PROVIDER must have verified it.
	const email = identity.email?.trim().toLowerCase();
	if (!email) throw new IdentityRefusal("email_missing");
	if (!identity.emailVerified) throw new IdentityRefusal("email_unverified");

	const local = await repo().findUserByEmail(email);
	if (!local) return createAccount(identity, email, device);

	// 3. An account with that email exists.
	if (isBlocked(local)) throw new IdentityRefusal("account_blocked");

	const existingLinks = await repo().listOAuthAccountsForUser(local.id);
	const sameProvider = existingLinks.find((account) => account.provider === identity.provider);

	if (sameProvider) {
		// The SAME identity: another request linked it a moment ago (a double click, two tabs) after
		// this one had already looked the identity up and found nothing. That is not a conflict;
		// this request just lost the race, and resolves to what the winner made.
		if (sameProvider.providerUserId === identity.providerUserId) {
			await repo().markOAuthLogin(sameProvider.id, new Date());
			const owner = await repo().findUserById(local.id);
			if (!owner) throw AppError.internal("A linked provider identity has no account");
			return { user: owner, outcome: "existing", oauthAccountId: sameProvider.id };
		}

		// A DIFFERENT account from the same provider claiming an address that already has one
		// linked is not something to merge silently.
		throw new IdentityRefusal("provider_conflict");
	}

	// Registered by email but never confirmed: whoever typed it in may not own the mailbox (an
	// attacker can register a victim's address first, then wait for the victim to arrive through
	// Google and land in the attacker's account). The provider just proved ownership, so the
	// account is wiped of everything the registrant could hold, then handed to this person.
	const reclaim = local.emailVerifiedAt === null;
	let owner: User = local;

	if (reclaim) {
		const cleaned = await repo().reclaimAccount(local.id);
		if (!cleaned) throw AppError.internal("Account disappeared while it was being reclaimed");
		owner = cleaned;
	}

	const account = link(owner.id, identity, new Date());
	await repo().createOAuthAccount(account);

	// Only after the link exists: a request that loses a race retries from the top and must not
	// have left a second set of audit rows behind.
	if (reclaim) {
		await recordAudit({
			event: AuditEvents.ACCOUNT_RECLAIMED,
			userId: owner.id,
			device,
			metadata: { provider: identity.provider },
		});
	}
	await recordAudit({
		event: AuditEvents.OAUTH_ACCOUNT_LINKED,
		userId: owner.id,
		device,
		metadata: { provider: identity.provider },
	});

	return { user: owner, outcome: reclaim ? "reclaimed" : "linked", oauthAccountId: account.id };
};

const MAX_ATTEMPTS = 3;

/**
 * Turns a verified provider claim into an account, creating or linking as needed.
 *
 * The caller must already have verified the claim with the provider (token signature, audience,
 * nonce, ...); nothing here re-checks that. What this guards against is the part the provider
 * cannot know: other accounts, blocked accounts, unverified local accounts, and races.
 */
export const resolveExternalIdentity = async (
	identity: ExternalIdentity,
	device: DeviceInfo,
): Promise<ResolvedIdentity> => {
	// A first sign-in can race with itself (double click, two tabs): the loser of an insert hits a
	// unique constraint. Starting over is correct, because the winner's rows now exist and the
	// second pass resolves to them instead of failing.
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await resolveOnce(identity, device);
		} catch (error) {
			if (attempt < MAX_ATTEMPTS && isUniqueViolation(error)) continue;
			throw error;
		}
	}
};
