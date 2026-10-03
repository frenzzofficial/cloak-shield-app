interface EmailConfig {
	email: {
		brandName: string;
		brandInitial: string;
		code: string;
		expiresIn: string;
		subject: string;
		supportUrl: string;
		year: number;
	};
}

export const emailConfig: EmailConfig = {
	email: {
		brandName: "cyantrix",
		brandInitial: "C",
		code: "482913",
		expiresIn: "10 minutes",
		subject: "Your verification code",
		supportUrl: "https://example.com/support",
		year: 2026,
	},
};
