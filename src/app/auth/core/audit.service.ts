import type { AuditEvent, AuditOutcome } from "../../../packages/configs/audit.config";
import { getAuthRepository } from "../../../packages/repository/drizzle/auth.repository";
import { bestEffort } from "../../../packages/utils/best-effort";
import type { DeviceInfo } from "./auth.types";

export interface AuditInput {
	event: AuditEvent;
	outcome?: AuditOutcome;
	/** The account the event is about, when there is one. */
	userId?: string | null;
	device?: DeviceInfo | undefined;
	/** Never put passwords, tokens or raw email addresses in here. */
	metadata?: Record<string, unknown>;
}

/**
 * Appends one row to the security audit trail. Best effort by design: a database hiccup while
 * writing the trail must not turn a successful sign-in into an error. (The failure is logged.)
 */
export const recordAudit = (input: AuditInput): Promise<void> =>
	bestEffort(`audit log (${input.event})`, async () => {
		await getAuthRepository().createAuditLog({
			id: crypto.randomUUID(),
			userId: input.userId ?? null,
			subjectId: input.userId ?? null,
			event: input.event,
			outcome: input.outcome ?? "SUCCESS",
			ipAddress: input.device?.ipAddress ?? "",
			userAgent: input.device?.userAgent ?? "",
			metadata: {
				...(input.device ? { deviceName: input.device.deviceName } : {}),
				...input.metadata,
			},
			createdAt: new Date(),
		});
	});
