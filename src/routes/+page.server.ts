import { fail, redirect } from '@sveltejs/kit';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { entityCategories, stories, universes } from '$lib/server/db/schema';
import { revokeSession, SESSION_COOKIE } from '$lib/server/auth';
import { saveEntityAutocomplete, userPreferences } from '$lib/server/preferences';
import { backupConfig, listRecentBackupRuns } from '$lib/server/backups';
import { queueBackup } from '$lib/server/jobs';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const list = await db
		.select()
		.from(universes)
		.where(eq(universes.ownerId, user.id))
		.orderBy(desc(universes.updatedAt));
	const storyList =
		list.length === 0
			? []
			: await db
					.select({ id: stories.id, title: stories.title, universeId: stories.universeId })
					.from(stories)
					.where(
						inArray(
							stories.universeId,
							list.map((universe) => universe.id)
						)
					)
					.orderBy(asc(stories.positionInSeries), asc(stories.createdAt));
	const preferences = await userPreferences(db, user.id);

	// The backups panel is the admin's: configuration state and the recent
	// runs, so a silently failing backup is visible.
	const isAdmin = user.role === 'admin';
	const backupsConfigured = isAdmin && backupConfig() !== null;
	const backupRuns = isAdmin ? await listRecentBackupRuns(db, 5) : [];

	return {
		user,
		universes: list,
		stories: storyList,
		preferences,
		isAdmin,
		backupsConfigured,
		backupRuns
	};
};

export const actions: Actions = {
	createUniverse: async ({ request, locals }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) {
			return fail(400, { message: 'Give the universe a name.' });
		}
		const universe = await db.transaction(async (tx) => {
			const [row] = await tx
				.insert(universes)
				.values({ ownerId: locals.user!.id, name })
				.returning();
			// Every universe starts with one lore category; users rename and
			// extend from there.
			await tx.insert(entityCategories).values({
				universeId: row.id,
				ownerId: locals.user!.id,
				name: 'Lore',
				sortOrder: 0
			});
			return row;
		});
		redirect(303, `/universes/${universe.id}`);
	},
	// A small stand-in until the account settings page arrives (step 32);
	// the Display settings select moves there.
	savePreferences: async ({ request, locals }) => {
		const data = await request.formData();
		const mode = String(data.get('entityAutocomplete') ?? '');
		if (mode !== 'popup' && mode !== 'ghost' && mode !== 'off') {
			return fail(400, { message: 'Pick an autocomplete mode.' });
		}
		await saveEntityAutocomplete(db, locals.user!.id, mode);
		return { prefSaved: true };
	},
	runBackup: async ({ locals }) => {
		if (locals.user!.role !== 'admin') {
			return fail(403, { message: 'Only the site admin can run backups.' });
		}
		if (!backupConfig()) {
			return fail(400, { message: 'Backups are not configured.' });
		}
		const queued = await queueBackup();
		if (!queued) {
			return fail(500, { message: 'Could not queue the backup.' });
		}
		return { backupQueued: true };
	},
	signout: async ({ locals, cookies }) => {
		if (locals.session) {
			await revokeSession(db, locals.session.id);
		}
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
