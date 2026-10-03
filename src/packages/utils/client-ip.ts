import { isIP } from "node:net";

export type TrustProxyMode = "none" | "vercel" | "cloudflare" | "forwarded";

const validIp = (value: string | null | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed && isIP(trimmed) !== 0 ? trimmed : undefined;
};

const lastForwarded = (header: string | null): string | undefined => {
	const parts = header?.split(",") ?? [];
	return validIp(parts[parts.length - 1]);
};

const firstForwarded = (header: string | null): string | undefined =>
	validIp(header?.split(",")[0]);

/**
 * Best-effort client IP for rate limiting and session metadata.
 *
 * Forwarding headers are client-controlled unless a proxy you operate overwrites them, so
 * they are only read in the mode that matches the real deployment (TRUST_PROXY). In "none"
 * mode, or when the trusted header is missing/malformed, the socket address is used, and
 * "unknown" is the last resort (no real server, e.g. unit tests calling app.handle()).
 */
export const getClientIp = (
	request: Request,
	socketIp: string | undefined,
	mode: TrustProxyMode,
): string => {
	const headers = request.headers;
	let fromProxy: string | undefined;

	switch (mode) {
		case "cloudflare":
			fromProxy = validIp(headers.get("cf-connecting-ip"));
			break;
		case "vercel":
			fromProxy =
				validIp(headers.get("x-vercel-forwarded-for")) ??
				validIp(headers.get("x-real-ip")) ??
				firstForwarded(headers.get("x-forwarded-for"));
			break;
		case "forwarded":
			// The rightmost entry is the one appended by our own proxy; everything to its
			// left was supplied by the client and can be anything.
			fromProxy = lastForwarded(headers.get("x-forwarded-for"));
			break;
		default:
			break;
	}

	return fromProxy ?? validIp(socketIp) ?? "unknown";
};
