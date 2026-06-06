import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db, isUniqueViolation } from '$lib/server/db';
import { universes } from '$lib/server/db/schema';
import { ownedUniverse } from '$lib/server/universe-access';
import { slugChangeError, slugTakenMessage } from '$lib/server/slugs';
import { universeTimeline, universeRevisionCount } from '$lib/server/revisions';
import { listCategories, saveCategories, universeContents } from '$lib/server/categories';
import { trashUniverse, UNIVERSE_TRASH_DAYS } from '$lib/server/universe-lifecycle';

export const load: PageServerLoad = async ({ params, locals }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	return {
		universe,
		contents: await universeContents(db, universe.id),
		categories: await listCategories(db, universe.id),
		timeline: await universeTimeline(db, universe.id, 100),
		revisionCount: await universeRevisionCount(db, universe.id),
		trashDays: UNIVERSE_TRASH_DAYS
	};
};

export const actions: Actions = {
	update: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const slug = String(data.get('slug') ?? '').trim();
		const descriptionMd = String(data.get('description') ?? '').trim() || null;
		if (!name) {
			return fail(400, { action: 'update', message: 'The universe needs a name.' });
		}
		const message = await slugChangeError(
			db,
			'universes',
			locals.user!.id,
			slug,
			universe.slug,
			universe.id
		);
		if (message) return fail(400, { action: 'update', message });
		try {
			await db
				.update(universes)
				.set({ name, slug, descriptionMd })
				.where(eq(universes.id, universe.id));
		} catch (err) {
			// A concurrent write can take the slug between the check and the update.
			if (!isUniqueViolation(err)) throw err;
			return fail(400, { action: 'update', message: slugTakenMessage('universes') });
		}
		// A changed slug moves this page's own URL.
		if (slug !== universe.slug) redirect(303, `/universes/${slug}`);
		return { action: 'update', saved: true };
	},
	saveCategories: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const data = await request.formData();
		let rows;
		try {
			rows = JSON.parse(String(data.get('categories') ?? '')) as unknown;
		} catch {
			return fail(400, { action: 'categories', message: 'Could not read the category list.' });
		}
		if (
			!Array.isArray(rows) ||
			rows.some(
				(row) =>
					typeof row !== 'object' ||
					row === null ||
					typeof (row as { name?: unknown }).name !== 'string'
			)
		) {
			return fail(400, { action: 'categories', message: 'Could not read the category list.' });
		}
		const result = await saveCategories(
			db,
			{ universeId: universe.id, ownerId: locals.user!.id },
			(rows as { id?: unknown; name: string; color?: unknown }[]).map((row) => ({
				id: typeof row.id === 'string' ? row.id : null,
				name: row.name,
				color: typeof row.color === 'string' && row.color !== '' ? row.color : null
			}))
		);
		if (!result.ok) return fail(400, { action: 'categories', message: result.reason });
		return { action: 'categories', saved: true };
	},
	delete: async ({ params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		await trashUniverse(db, locals.user!.id, universe.id);
		redirect(303, '/');
	}
};
