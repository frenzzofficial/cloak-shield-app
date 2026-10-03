import { envAppConfig } from "@/packages/env/app.env";
import { getClientIp } from "@/packages/utils/client-ip";
import { clampUserAgent, parseUserAgent } from "@/packages/utils/user-agent";
import type { DeviceInfo } from "../../app/auth/email/email.services";

export const extractDeviceInfo = (
	request: Request,
	server: Bun.Server<unknown> | null,
): DeviceInfo => {
	const userAgent = request.headers.get("user-agent");

	return {
		...parseUserAgent(userAgent),
		ipAddress: getClientIp(
			request,
			server?.requestIP(request)?.address,
			envAppConfig.TRUST_PROXY,
		),
		userAgent: clampUserAgent(userAgent),
	};
};
