import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db, isUniqueViolation } from '$lib/server/db';
import { universes } from '$lib/server/db/schema';
import { ownedUniverse } from '$lib/server/universe-access';
import { uniqueSlug } from '$lib/server/slugs';
import { universeTimeline, universeRevisionCount } from '$lib/server/revisions';
import { listCategories, saveCategories, universeContents } from '$lib/server/categories';
import { trashUniverse, UNIVERSE_TRASH_DAYS } from '$lib/server/universe-lifecycle';
import { parseStoryZip, StoryZipError, type ImportPlan } from '$lib/import-markdown';
import { previewImport, runImport } from '$lib/server/import-story';

// The uploaded story archive, parsed, or a fail() the action returns as-is.
async function planFromUpload(data: FormData) {
	const file = data.get('archive');
	if (!(file instanceof File) || file.size === 0) {
		return { fail: fail(400, { action: 'import' as const, message: 'Choose a zip file first.' }) };
	}
	try {
		return { plan: parseStoryZip(new Uint8Array(await file.arrayBuffer())) };
	} catch (err) {
		if (err instanceof StoryZipError) {
			return { fail: fail(400, { action: 'import' as const, message: err.message }) };
		}
		throw err;
	}
}

export const load: PageServerLoad = async ({ params, locals }) => {
	// Details rests on /universes/<slug> itself; the other sections have
	// their own page.
	if (params.section !== undefined && !['categories', 'history', 'export'].includes(params.section))
		error(404, 'Not found');
	const universe = await ownedUniverse(params.id, locals.user!.id);
	const [contents, categories, timeline, revisionCount] = await Promise.all([
		universeContents(db, universe.id),
		listCategories(db, universe.id),
		universeTimeline(db, universe.id, 100),
		universeRevisionCount(db, universe.id)
	]);
	return {
		universe,
		contents,
		categories,
		timeline,
		revisionCount,
		trashDays: UNIVERSE_TRASH_DAYS
	};
};

export const actions: Actions = {
	update: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const descriptionMd = String(data.get('description') ?? '').trim() || null;
		if (!name) {
			return fail(400, { action: 'update', message: 'The universe needs a name.' });
		}
		// The slug follows the name: a rename moves the universe's URL, an
		// unchanged name leaves it alone.
		const save = async (slug: string) => {
			await db
				.update(universes)
				.set({ name, slug, descriptionMd })
				.where(eq(universes.id, universe.id));
			return slug;
		};
		const freshSlug = () => uniqueSlug(db, 'universes', locals.user!.id, name, 'universe');
		let slug;
		try {
			slug = await save(name === universe.name ? universe.slug : await freshSlug());
		} catch (err) {
			// A concurrent create took the slug between the pick and the update.
			if (!isUniqueViolation(err)) throw err;
			slug = await save(await freshSlug());
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
	},
	previewImport: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const upload = await planFromUpload(await request.formData());
		if (upload.fail) return upload.fail;
		return {
			action: 'import' as const,
			preview: await previewImport(db, universe, upload.plan as ImportPlan)
		};
	},
	runImport: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const upload = await planFromUpload(await request.formData());
		if (upload.fail) return upload.fail;
		return {
			action: 'import' as const,
			imported: await runImport(db, universe, upload.plan as ImportPlan)
		};
	}
};
