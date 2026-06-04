import { fail, redirect } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { db } from '$lib/server/db';
import { entityCategories, stories, universes } from '$lib/server/db/schema';
import { revokeSession, SESSION_COOKIE } from '$lib/server/auth';
import { savePreferences, userPreferences } from '$lib/server/preferences';
import { backupConfig, listRecentBackupRuns } from '$lib/server/backups';
import { queueBackup } from '$lib/server/jobs';
import { listPublications, takedownPublication } from '$lib/server/publish';
import { users } from '$lib/server/db/schema';

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

	// Public archive standing for this user; the admin additionally sees
	// everything published on the instance.
	const [archive] = await db
		.select({ handle: users.handle, enabled: users.publicArchiveEnabled })
		.from(users)
		.where(eq(users.id, user.id));
	const published = isAdmin ? await listPublications(db, 20) : [];

	return {
		user,
		universes: list,
		stories: storyList,
		preferences,
		isAdmin,
		backupsConfigured,
		backupRuns,
		archive,
		published
	};
};

export const actions: Actions = {
	createUniverse: async ({ request, locals }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) {
			return fail(400, { scope: 'universe', message: 'Give the universe a name.' });
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
		const marks = String(data.get('continuousSceneMarks') ?? '');
		if (mode !== 'popup' && mode !== 'ghost' && mode !== 'off') {
			return fail(400, { scope: 'prefs', message: 'Pick an autocomplete mode.' });
		}
		if (marks !== 'shown' && marks !== 'hidden') {
			return fail(400, { scope: 'prefs', message: 'Pick a scene marks option.' });
		}
		await savePreferences(db, locals.user!.id, {
			entityAutocomplete: mode,
			continuousSceneMarks: marks
		});
		return { prefSaved: true };
	},
	runBackup: async ({ locals }) => {
		if (locals.user!.role !== 'admin') {
			return fail(403, { scope: 'backup', message: 'Only the site admin can run backups.' });
		}
		if (!backupConfig()) {
			return fail(400, { scope: 'backup', message: 'Backups are not configured.' });
		}
		const queued = await queueBackup();
		if (!queued) {
			return fail(500, { scope: 'backup', message: 'Could not queue the backup.' });
		}
		return { backupQueued: true };
	},
	claimHandle: async ({ request, locals }) => {
		const data = await request.formData();
		const handle = String(data.get('handle') ?? '')
			.trim()
			.toLowerCase();
		if (!/^[a-z0-9][a-z0-9-]{2,29}$/.test(handle)) {
			return fail(400, {
				scope: 'handle',
				message: 'Handles are 3-30 characters: letters, numbers, and dashes.'
			});
		}
		try {
			// A handle is claimed once and never changed: publications carry a
			// denormalised copy and the reader matches on it alone, so freeing
			// a handle for someone else to claim would serve your editions
			// under their name. The IS NULL guard makes it write-once.
			const claimed = await db
				.update(users)
				.set({ handle })
				.where(and(eq(users.id, locals.user!.id), isNull(users.handle)))
				.returning({ id: users.id });
			if (claimed.length === 0) {
				return fail(400, {
					scope: 'handle',
					message: 'You already have a handle; it cannot be changed.'
				});
			}
		} catch (error) {
			if ((error as { cause?: { code?: string } }).cause?.code === '23505') {
				return fail(400, { scope: 'handle', message: 'That handle is taken.' });
			}
			throw error;
		}
		return { handleSaved: true };
	},
	setArchive: async ({ request, locals }) => {
		if (locals.user!.role !== 'admin') {
			return fail(403, {
				scope: 'archive',
				message: 'Only the site admin can enable public archives.'
			});
		}
		const data = await request.formData();
		const email = String(data.get('email') ?? '').trim();
		const enabled = data.get('enabled') === 'on';
		const updated = await db
			.update(users)
			.set({ publicArchiveEnabled: enabled })
			.where(eq(users.email, email))
			.returning({ id: users.id });
		if (updated.length === 0) {
			return fail(404, { scope: 'archive', message: 'No user with that email.' });
		}
		return { archiveSaved: true };
	},
	takedown: async ({ request, locals }) => {
		if (locals.user!.role !== 'admin') {
			return fail(403, {
				scope: 'takedown',
				message: 'Only the site admin can take down editions.'
			});
		}
		const data = await request.formData();
		const publicationId = String(data.get('publicationId') ?? '');
		// A malformed id would otherwise reach a uuid-typed query and 500;
		// guard it the way setArchive guards a missing email.
		if (!UUID.test(publicationId)) {
			return fail(400, { scope: 'takedown', message: 'That edition does not exist.' });
		}
		if (!(await takedownPublication(db, publicationId))) {
			return fail(404, { scope: 'takedown', message: 'That edition does not exist.' });
		}
		return { takedownDone: true };
	},
	signout: async ({ locals, cookies }) => {
		if (locals.session) {
			await revokeSession(db, locals.session.id);
		}
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
