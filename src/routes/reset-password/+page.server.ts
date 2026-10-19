import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { resetPassword } from '$lib/server/password-reset';
import { formText } from '$lib/server/validation';

export const load: PageServerLoad = async ({ url }) => {
	// Carry the token to the form so it survives the round trip without the user
	// seeing or retyping it.
	return { token: url.searchParams.get('token') ?? '' };
};

export const actions: Actions = {
	default: async ({ request }) => {
		const data = await request.formData();
		const token = formText(data, 'token');
		const password = formText(data, 'password');

		const result = await resetPassword(db, token, password);
		if (!result.ok) {
			return fail(400, { message: result.reason });
		}
		return { done: true };
	}
};
