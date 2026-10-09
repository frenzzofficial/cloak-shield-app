import {
	type OAuthProvider,
	OAuthProviderLabels,
} from "../../../packages/configs/oauth-provider.config";
import { getMailer } from "../../../packages/mailer/mailer";
import {
	accountDeletedTemplate,
	clientLink,
	confirmEmailChangeTemplate,
	emailChangedTemplate,
	emailChangeRequestedTemplate,
	newDeviceTemplate,
	passwordChangedTemplate,
	passwordSetTemplate,
	providerLinkedTemplate,
	resetPasswordTemplate,
	verifyEmailTemplate,
} from "../../../packages/mailer/templates";
import type { User } from "../../../packages/schema/user.schema";
import { bestEffort } from "../../../packages/utils/best-effort";
import type { DeviceInfo } from "./auth.types";

// Every message goes through here so that a mail failure is logged and never reaches the caller.
// Security notices (new device, password changed, ...) are always sent: they are not
// "notifications" the user can opt out of with emailNotifications.

type Template = { subject: string; text: string };

const send = (label: string, to: string, template: Template): Promise<void> =>
	bestEffort(label, () => getMailer().send({ to, ...template }));

const summary = (device: DeviceInfo) => ({
	deviceName: device.deviceName,
	ipAddress: device.ipAddress,
	when: new Date(),
});

export const sendVerificationLink = (to: string, token: string): Promise<void> =>
	send("verification email", to, verifyEmailTemplate(clientLink("/verify-email", token)));

export const sendResetLink = (to: string, token: string): Promise<void> =>
	send("password reset email", to, resetPasswordTemplate(clientLink("/reset-password", token)));

export const sendEmailChangeLink = (newEmail: string, token: string): Promise<void> =>
	send(
		"email change confirmation",
		newEmail,
		confirmEmailChangeTemplate(clientLink("/confirm-email-change", token)),
	);

export const notifyEmailChangeRequested = (user: User, newEmail: string): Promise<void> =>
	send("email change notice", user.email, emailChangeRequestedTemplate(newEmail));

/** Goes to the OLD address: the one place the real owner will still see it. */
export const notifyEmailChanged = (oldEmail: string, newEmail: string): Promise<void> =>
	send("email changed notice", oldEmail, emailChangedTemplate(newEmail));

export const notifyPasswordChanged = (user: User, device: DeviceInfo): Promise<void> =>
	send("password changed notice", user.email, passwordChangedTemplate(summary(device)));

export const notifyPasswordSet = (user: User, device: DeviceInfo): Promise<void> =>
	send("password set notice", user.email, passwordSetTemplate(summary(device)));

export const notifyProviderLinked = (
	user: User,
	provider: OAuthProvider,
	device: DeviceInfo,
): Promise<void> =>
	send(
		"provider linked notice",
		user.email,
		providerLinkedTemplate(OAuthProviderLabels[provider], summary(device)),
	);

export const notifyNewDevice = (user: User, device: DeviceInfo): Promise<void> =>
	send("new device notice", user.email, newDeviceTemplate(summary(device)));

export const notifyAccountDeleted = (email: string): Promise<void> =>
	send("account deleted notice", email, accountDeletedTemplate());
