import { fail, redirect } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { entityCategories, stories, universes, users } from '$lib/server/db/schema';
import { revokeSession, SESSION_COOKIE } from '$lib/server/auth';
import { savePreferences, userPreferences } from '$lib/server/preferences';

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

	// This user's own publishing standing (their handle and whether an admin has
	// enabled their archive). Site administration lives at /admin.
	const [archive] = await db
		.select({ handle: users.handle, enabled: users.publicArchiveEnabled })
		.from(users)
		.where(eq(users.id, user.id));

	return {
		user,
		universes: list,
		stories: storyList,
		preferences,
		isAdmin: user.role === 'admin',
		archive
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
	signout: async ({ locals, cookies }) => {
		if (locals.session) {
			await revokeSession(db, locals.session.id);
		}
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
