import { setAuthRepository } from "../src/packages/repository/drizzle/auth.repository";
import { defineAccountFlowTests } from "./helpers/account-flow";
import { defineAuthFlowTests } from "./helpers/auth-flow";
import { defineGoogleFlowTests } from "./helpers/google-flow";
import { defineIdentityTests } from "./helpers/identity-flow";
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

defineIdentityTests("provider identities over the core (in-memory repository)", {
	install: () => setAuthRepository(memory),
	backdateSignIn: async (sessionId, to) => {
		memory.patchSession(sessionId, { createdAt: to });
	},
});

defineGoogleFlowTests("Google sign-in over HTTP (in-memory repository)", {
	install: () => setAuthRepository(memory),
	auditDump: async () => JSON.stringify(memory.allAuditLogs()),
});
