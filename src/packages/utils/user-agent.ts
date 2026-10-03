export interface ParsedUserAgent {
	deviceName: string;
	platform: string;
	browser: string;
	os: string;
}

const MAX_USER_AGENT_LENGTH = 512;

// Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari".
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bEdg(?:e|A|iOS)?\//, "Edge"],
	[/\bOPR\/|\bOpera\b/, "Opera"],
	[/\bSamsungBrowser\//, "Samsung Internet"],
	[/\bFirefox\/|\bFxiOS\//, "Firefox"],
	[/\bChrome\/|\bCriOS\//, "Chrome"],
	[/\bSafari\//, "Safari"],
];

// iPhone/iPad UAs contain "like Mac OS X", so they must be tested before macOS.
const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bWindows\b/, "Windows"],
	[/\bAndroid\b/, "Android"],
	[/\biPhone\b|\biPad\b|\biPod\b/, "iOS"],
	[/\bMac OS X\b|\bMacintosh\b/, "macOS"],
	[/\bCrOS\b/, "ChromeOS"],
	[/\bLinux\b/, "Linux"],
];

const firstMatch = (
	table: ReadonlyArray<readonly [RegExp, string]>,
	value: string,
): string | undefined => table.find(([pattern]) => pattern.test(value))?.[1];

/** Clamp what we store so a hostile client can't write kilobytes per session row. */
export const clampUserAgent = (value: string | null | undefined): string =>
	(value ?? "unknown").slice(0, MAX_USER_AGENT_LENGTH);

export const parseUserAgent = (value: string | null | undefined): ParsedUserAgent => {
	const userAgent = clampUserAgent(value);

	const browser = firstMatch(BROWSERS, userAgent) ?? "Unknown browser";
	const os = firstMatch(SYSTEMS, userAgent) ?? "Unknown OS";

	let platform = "desktop";
	if (/\biPad\b|\bTablet\b/.test(userAgent)) platform = "tablet";
	else if (/\bMobile\b|\biPhone\b|\bAndroid\b/.test(userAgent)) platform = "mobile";
	else if (browser === "Unknown browser" && os === "Unknown OS") platform = "unknown";

	return { deviceName: `${browser} on ${os}`, platform, browser, os };
};
