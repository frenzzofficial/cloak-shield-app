export const UserGenders = {
	MALE: "MALE",
	FEMALE: "FEMALE",
	OTHER: "OTHER",
	PREFER_NOT_TO_SAY: "PREFER_NOT_TO_SAY",
} as const;

export const UserGenderValues = Object.values(UserGenders);

export type UserGender = keyof typeof UserGenders;
