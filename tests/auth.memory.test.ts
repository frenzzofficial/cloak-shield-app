import { setAuthRepository } from "@/packages/repository/drizzle/auth.repository";
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
});
