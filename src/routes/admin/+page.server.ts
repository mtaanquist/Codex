import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { approveUser, listPendingUsers, rejectUser } from '$lib/server/admin';

function requireAdmin(locals: App.Locals) {
	if (locals.user?.role !== 'admin') error(404, 'Not found');
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);
	return { pending: await listPendingUsers(db) };
};

export const actions: Actions = {
	approve: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const userId = String(data.get('userId') ?? '');
		if (!(await approveUser(db, userId))) {
			return fail(400, { message: 'That account is no longer pending.' });
		}
		return { approved: true };
	},
	reject: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const userId = String(data.get('userId') ?? '');
		if (!(await rejectUser(db, userId))) {
			return fail(400, { message: 'That account is no longer pending.' });
		}
		return { rejected: true };
	}
};
