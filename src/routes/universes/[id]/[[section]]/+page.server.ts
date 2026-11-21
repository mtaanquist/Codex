import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { isUniqueViolation } from '#lib/server/db-errors';
import { universes } from '#lib/server/db/schema';
import { ownedUniverse } from '#lib/server/universe-access';
import { uniqueSlug } from '#lib/server/slugs';
import { universeTimeline, universeRevisionCount } from '#lib/server/revisions';
import { listCategories, saveCategories, universeContents } from '#lib/server/categories';
import { trashUniverse, UNIVERSE_TRASH_DAYS } from '#lib/server/universe-lifecycle';
import { parseStoryZip, StoryZipError, type ImportPlan } from '#lib/import-markdown';
import { parseDocument, DocumentImportError } from '#lib/server/import-document';
import { previewImport, runImport } from '#lib/server/import-story';
import { effectiveAssetConfig } from '#lib/server/assets';
import { listUserExports, markExportFailed, requestExport } from '#lib/server/user-exports';
import { queueUserExport } from '#lib/server/jobs';
import { exportLimit } from '#lib/server/rate-limit';
import { formText } from '#lib/server/validation';
import { assistantLayout, saveUniverseModels } from '#lib/server/llm/config';
import { modelsFromForm, scopeModelSettings } from '#lib/server/llm/scope-models';
import { decideEntityProposal, decideSplitProposal, listProposals } from '#lib/server/proposals';
import { queueSceneMentions, queueUniverseMentions } from '#lib/server/jobs';
import { isUuid } from '#lib/slug';

// The uploaded file, parsed into a plan: a Codex export zip, or a Word/EPUB
// manuscript by its extension. Returns a fail() the action passes straight back.
async function planFromUpload(data: FormData) {
	const file = data.get('archive');
	if (!(file instanceof File) || file.size === 0) {
		return { fail: fail(400, { action: 'import' as const, message: 'Choose a file first.' }) };
	}
	const bytes = new Uint8Array(await file.arrayBuffer());
	const isManuscript = /\.(docx|epub)$/i.test(file.name);
	try {
		const plan = isManuscript ? await parseDocument(bytes, file.name) : parseStoryZip(bytes);
		return { plan };
	} catch (err) {
		if (err instanceof StoryZipError || err instanceof DocumentImportError) {
			return { fail: fail(400, { action: 'import' as const, message: err.message }) };
		}
		throw err;
	}
}

export const load: PageServerLoad = async ({ params, locals }) => {
	// Details rests on /universes/<slug> itself; the other sections have
	// their own page.
	if (
		params.section !== undefined &&
		!['categories', 'suggestions', 'assistant', 'history', 'export'].includes(params.section)
	)
		error(404, 'Not found');
	const universe = await ownedUniverse(params.id, locals.user!.id);
	const [contents, categories, timeline, revisionCount, assistant] = await Promise.all([
		universeContents(db, universe.id),
		listCategories(db, universe.id),
		universeTimeline(db, universe.id, 100),
		universeRevisionCount(db, universe.id),
		assistantLayout(db, locals.user!.id)
	]);
	// The section shows only with the Assistant set up, so its page does too.
	if (params.section === 'assistant' && !assistant.tabEnabled) error(404, 'Not found');
	return {
		// The model pickers of the Assistant section; null hides the section.
		assistantModels: assistant.tabEnabled
			? await scopeModelSettings(db, locals.user!.id, { universeId: universe.id })
			: null,
		universe,
		contents,
		categories,
		// Entries and scene splits the Assistant or a connected app proposed.
		proposals: await listProposals(db, locals.user!.id, universe.id),
		timeline,
		revisionCount,
		trashDays: UNIVERSE_TRASH_DAYS,
		assetsConfigured: (await effectiveAssetConfig(db)) !== null,
		exports: await listUserExports(db, locals.user!.id, {
			scope: 'universe',
			targetId: universe.id
		})
	};
};

export const actions: Actions = {
	requestExport: async ({ params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		if (!exportLimit(locals.user!.id).allowed) {
			return fail(429, {
				action: 'export',
				message: 'Too many exports just now. Try again shortly.'
			});
		}
		const result = await requestExport(db, locals.user!.id, {
			scope: 'universe',
			targetId: universe.id,
			format: 'zip'
		});
		if (!result.ok) return fail(400, { action: 'export', message: result.reason });
		if (!(await queueUserExport(result.id))) {
			await markExportFailed(db, result.id, 'Could not start the export.');
			return fail(503, { action: 'export', message: 'Could not start the export. Try again.' });
		}
		return { action: 'export', queued: true };
	},
	update: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const data = await request.formData();
		const name = formText(data, 'name').trim();
		const descriptionMd = formText(data, 'description').trim() || null;
		const establishedSetting = data.get('establishedSetting') === 'on';
		if (!name) {
			return fail(400, { action: 'update', message: 'The universe needs a name.' });
		}
		// The slug follows the name: a rename moves the universe's URL, an
		// unchanged name leaves it alone.
		const save = async (slug: string) => {
			await db
				.update(universes)
				.set({ name, slug, descriptionMd, establishedSetting })
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
			rows = JSON.parse(formText(data, 'categories')) as unknown;
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
	saveAssistantModels: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		await saveUniverseModels(db, universe.id, modelsFromForm(await request.formData()));
		return { action: 'assistant-models' as const, saved: true };
	},
	delete: async ({ params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		await trashUniverse(db, locals.user!.id, universe.id);
		redirect(303, '/');
	},
	// Accept or dismiss a suggested entry. Accepting adds it to the universe.
	decideEntity: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const data = await request.formData();
		const id = formText(data, 'id');
		const accept = formText(data, 'decision') === 'accept';
		// Only one of this universe's is found; anything else decides nothing.
		const result = isUuid(id)
			? await decideEntityProposal(
					db,
					locals.user!.id,
					universe.id,
					id,
					accept ? 'accept' : 'dismiss'
				)
			: null;
		if (!result || (!result.ok && result.code === 'not_found')) {
			return fail(404, {
				action: 'suggestions',
				message: 'That suggestion is no longer there.'
			});
		}
		if (!result.ok) return fail(409, { action: 'suggestions', message: result.reason });
		// The new name may already appear in existing scenes.
		if (result.entityId) await queueUniverseMentions(universe.id);
		return {
			action: 'suggestions',
			done: accept ? 'Added to this universe. Find it in Plan.' : 'Dismissed.'
		};
	},
	// Split a scene where an app proposed, or dismiss the proposal.
	decideSplit: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const data = await request.formData();
		const id = formText(data, 'id');
		const confirm = formText(data, 'decision') === 'confirm';
		const result = isUuid(id)
			? await decideSplitProposal(
					db,
					locals.user!.id,
					universe.id,
					id,
					confirm ? 'confirm' : 'dismiss'
				)
			: null;
		if (!result || (!result.ok && result.code === 'not_found')) {
			return fail(404, {
				action: 'suggestions',
				message: 'That proposal is no longer there.'
			});
		}
		if (!result.ok) return fail(409, { action: 'suggestions', message: result.reason });
		for (const sceneId of [result.splitSceneId, result.newSceneId]) {
			if (sceneId) await queueSceneMentions(sceneId);
		}
		return { action: 'suggestions', done: confirm ? 'The scene is split in two.' : 'Dismissed.' };
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
