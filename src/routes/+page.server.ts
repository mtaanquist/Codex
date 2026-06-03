import { fail, redirect } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { universes } from '$lib/server/db/schema';
import { revokeSession, SESSION_COOKIE } from '$lib/server/auth';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const list = await db
		.select()
		.from(universes)
		.where(eq(universes.ownerId, user.id))
		.orderBy(desc(universes.updatedAt));
	return { user, universes: list };
};

export const actions: Actions = {
	createUniverse: async ({ request, locals }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) {
			return fail(400, { message: 'Give the universe a name.' });
		}
		const [universe] = await db
			.insert(universes)
			.values({ ownerId: locals.user!.id, name })
			.returning();
		redirect(303, `/universes/${universe.id}`);
	},
	signout: async ({ locals, cookies }) => {
		if (locals.session) {
			await revokeSession(db, locals.session.id);
		}
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
