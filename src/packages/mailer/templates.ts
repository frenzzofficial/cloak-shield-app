import { envClientConfig } from "@/packages/env/client.env";
import { envPublicConfig } from "@/packages/env/public.env";
import type { MailMessage } from "./mailer";

type Template = Pick<MailMessage, "subject" | "text">;

const appName = envPublicConfig.APP_NAME;

/** A link into the frontend, e.g. clientLink("/verify-email", token) */
export const clientLink = (path: string, token: string): string =>
	`${envClientConfig.CLIENT_ORIGIN}${path}?token=${encodeURIComponent(token)}`;

/** "jane.doe@example.com" -> "j***@example.com": enough to recognize, not enough to harvest. */
export const maskEmail = (email: string): string => {
	const [local = "", domain = ""] = email.split("@");
	return `${local.slice(0, 1)}***@${domain}`;
};

const footer = `\n\n- The ${appName} team`;

export interface DeviceSummary {
	deviceName: string;
	ipAddress: string;
	when: Date;
}

const describeDevice = ({ deviceName, ipAddress, when }: DeviceSummary): string =>
	`Device: ${deviceName}\nIP address: ${ipAddress}\nTime: ${when.toUTCString()}`;

export const verifyEmailTemplate = (link: string): Template => ({
	subject: `Verify your email address for ${appName}`,
	text: `Confirm your email address by opening this link:\n\n${link}\n\nIf you did not create an account, you can ignore this message.${footer}`,
});

export const resetPasswordTemplate = (link: string): Template => ({
	subject: `Reset your ${appName} password`,
	text: `Choose a new password by opening this link:\n\n${link}\n\nIf you did not ask for this, ignore this message; your password has not changed.${footer}`,
});

export const confirmEmailChangeTemplate = (link: string): Template => ({
	subject: `Confirm your new email address for ${appName}`,
	text: `Someone asked to use this address for a ${appName} account. Confirm it by opening this link:\n\n${link}\n\nIf this was not you, ignore this message and nothing will change.${footer}`,
});

export const emailChangeRequestedTemplate = (newEmail: string): Template => ({
	subject: `A change of email address was requested on your ${appName} account`,
	text: `A request was made to change your account email to ${maskEmail(newEmail)}.\n\nNothing changes until that address is confirmed. If this was not you, change your password now and sign out your other devices.${footer}`,
});

export const emailChangedTemplate = (newEmail: string): Template => ({
	subject: `Your ${appName} email address was changed`,
	text: `The email address on your account was changed to ${maskEmail(newEmail)}, and every device was signed out.\n\nIf this was not you, contact support immediately.${footer}`,
});

export const passwordChangedTemplate = (device: DeviceSummary): Template => ({
	subject: `Your ${appName} password was changed`,
	text: `Your password was just changed.\n\n${describeDevice(device)}\n\nIf this was not you, reset your password right away and contact support.${footer}`,
});

export const newDeviceTemplate = (device: DeviceSummary): Template => ({
	subject: `New sign-in to your ${appName} account`,
	text: `We noticed a sign-in from a device we have not seen recently.\n\n${describeDevice(device)}\n\nIf this was you, no action is needed. If not, change your password and sign out your other devices.${footer}`,
});

export const accountDeletedTemplate = (): Template => ({
	subject: `Your ${appName} account was deleted`,
	text: `Your account and its data have been deleted, as you requested.\n\nIf you did not do this, contact support immediately.${footer}`,
});
