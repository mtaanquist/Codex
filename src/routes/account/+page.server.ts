import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	changeDisplayName,
	changePassword,
	listSessions,
	revokeOtherSessions,
	revokeOwnSession
} from '$lib/server/account';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const sessionId = locals.session!.id;
	return {
		displayName: user.displayName,
		email: user.email,
		sessions: await listSessions(db, user.id, sessionId)
	};
};

export const actions: Actions = {
	updateName: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await changeDisplayName(
			db,
			locals.user!.id,
			String(data.get('displayName') ?? '')
		);
		if (!result.ok) return fail(400, { scope: 'name', message: result.reason });
		return { scope: 'name', saved: true };
	},
	changePassword: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await changePassword(
			db,
			locals.user!.id,
			locals.session!.id,
			String(data.get('currentPassword') ?? ''),
			String(data.get('newPassword') ?? '')
		);
		if (!result.ok) return fail(400, { scope: 'password', message: result.reason });
		return { scope: 'password', saved: true };
	},
	revokeSession: async ({ request, locals }) => {
		const data = await request.formData();
		const sessionId = String(data.get('sessionId') ?? '');
		if (sessionId === locals.session!.id) {
			return fail(400, { scope: 'sessions', message: 'Use sign out to end your current session.' });
		}
		await revokeOwnSession(db, locals.user!.id, sessionId);
		return { scope: 'sessions', saved: true };
	},
	revokeOthers: async ({ locals }) => {
		await revokeOtherSessions(db, locals.user!.id, locals.session!.id);
		return { scope: 'sessions', saved: true };
	}
};
