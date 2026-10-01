import type { Context } from "elysia";

type JsonResponse<T> = {
	success: true;
	data: T;
};

// type ErrorResponse = {
// 	success: false;
// 	error: string;
// };

export const ok = <T>({ set }: Context, data: T, status = 200): JsonResponse<T> => {
	set.status = status;

	return {
		success: true,
		data,
	};
};

// export const err = ({ set }: Context, message: string, status = 500): ErrorResponse => {
// 	set.status = status;

// 	return {
// 		success: false,
// 		error: message,
// 	};
// };
