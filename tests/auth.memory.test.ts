import { setAuthRepository } from "@/packages/repository/drizzle/auth.repository";
import { defineAccountFlowTests } from "./helpers/account-flow";
import { defineAuthFlowTests } from "./helpers/auth-flow";
import { InMemoryAuthRepository } from "./helpers/memory-repo";

const memory = new InMemoryAuthRepository();

defineAuthFlowTests("email auth over HTTP (in-memory repository)", {
	install: () => setAuthRepository(memory),
	backdateRotation: async (sessionId) => {
		memory.patchSession(sessionId, { refreshRotatedAt: new Date(Date.now() - 10 * 60_000) });
	},
	expireSession: async (sessionId) => {
		memory.patchSession(sessionId, { expiresAt: new Date(Date.now() - 1_000) });
	},
	auditDump: async () => JSON.stringify(memory.allAuditLogs()),
	auditEventsForSubject: async (subjectId) =>
		memory
			.allAuditLogs()
			.filter((entry) => entry.subjectId === subjectId)
			.map((entry) => entry.event),
	wipeAudit: async (userId) => memory.wipeAuditFor(userId),
});

defineAccountFlowTests("account security over HTTP (in-memory repository)", {
	install: () => setAuthRepository(memory),
	backdateRotation: async (sessionId) => {
		memory.patchSession(sessionId, { refreshRotatedAt: new Date(Date.now() - 10 * 60_000) });
	},
	expireSession: async (sessionId) => {
		memory.patchSession(sessionId, { expiresAt: new Date(Date.now() - 1_000) });
	},
	auditDump: async () => JSON.stringify(memory.allAuditLogs()),
	auditEventsForSubject: async (subjectId) =>
		memory
			.allAuditLogs()
			.filter((entry) => entry.subjectId === subjectId)
			.map((entry) => entry.event),
	wipeAudit: async (userId) => memory.wipeAuditFor(userId),
});
