// cspell:ignore Fevil Cevil Fapi
// `?redirect=` says where the user wants to land after signing in. Taken as-is it is an open
// redirect: an attacker sends a victim a real "Sign in with Google" link whose redirect points at
// a look-alike site, and the victim arrives there already logged in. So only a PATH on our own
// frontend is accepted; the scheme and host always come from configuration, never from the request.

const MAX_LENGTH = 512;
const PLACEHOLDER_ORIGIN = "https://placeholder.invalid";

const hasControlCharacter = (value: string): boolean => {
	for (const character of value) {
		const code = character.charCodeAt(0);
		// Browsers silently drop tabs and newlines, so "/\t/evil.com" becomes "//evil.com".
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
};

export const safeRedirectPath = (input: unknown, fallback = "/"): string => {
	if (typeof input !== "string") return fallback;

	const value = input.trim();
	if (value.length === 0 || value.length > MAX_LENGTH) return fallback;
	if (!value.startsWith("/")) return fallback;
	if (value.startsWith("//")) return fallback;
	// Browsers treat a backslash as a slash, so "/\evil.com" is "//evil.com" to them.
	if (value.includes("\\") || hasControlCharacter(value)) return fallback;

	// Encoded tricks: "/%2Fevil.com" decodes to "//evil.com", "/%5Cevil.com" to "/\evil.com".
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return fallback;
	}
	if (decoded.startsWith("//") || decoded.includes("\\") || hasControlCharacter(decoded)) {
		return fallback;
	}

	// Last line of defense: resolve it the way a browser would and require it to stay on the origin.
	try {
		if (new URL(value, PLACEHOLDER_ORIGIN).origin !== PLACEHOLDER_ORIGIN) return fallback;
	} catch {
		return fallback;
	}

	return value;
};
