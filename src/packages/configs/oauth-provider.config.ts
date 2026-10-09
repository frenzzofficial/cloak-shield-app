// Third-party sign-in providers an account can be linked to. DISCORD is listed now so adding that
// plugin later needs no database change (the column is an enum).
export const OAuthProviders = {
	GOOGLE: "GOOGLE",
	DISCORD: "DISCORD",
} as const;

export type OAuthProvider = keyof typeof OAuthProviders;

/** For emails and UI text. */
export const OAuthProviderLabels: Record<OAuthProvider, string> = {
	GOOGLE: "Google",
	DISCORD: "Discord",
};
