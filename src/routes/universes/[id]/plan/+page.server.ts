import { sql } from 'drizzle-orm';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { effectiveAssetConfig } from '$lib/server/assets';
import { storyStatus } from '$lib/dashboard';
import { ownedUniverse } from '$lib/server/universe-access';
import { planActions } from '$lib/server/plan-actions';
import { createStoryInUniverse } from '$lib/server/story-create';
import {
	entityAppearances,
	entityMentionCount,
	planEntityLists,
	resolvePlanEntity,
	type PlanAppearance
} from '$lib/server/plan-data';
import {
	listEntityRelationships,
	listRelationTypes,
	type RelationshipView
} from '$lib/server/relationships';
import {
	getRevision,
	listRevisions,
	type RevisionEntityType,
	type RevisionRow
} from '$lib/server/revisions';
import type { EntityKind } from '$lib/components/EntityEditor.svelte';

type StoryBoardRow = {
	id: string;
	slug: string;
	title: string;
	status: ReturnType<typeof storyStatus>;
	words: number;
	sceneCount: number;
};

// The no-selection centre panel: each story in a lane for its derived
// status, the same derivation as the library's pill.
async function loadStoryBoard(universeId: string): Promise<StoryBoardRow[]> {
	const result = await db.execute(sql`
		select st.id, st.slug, st.title,
			count(s.id)::int as scene_count,
			coalesce(sum(s.word_count), 0)::int as words,
			count(s.id) filter (where s.status = 'outline')::int as outline,
			count(s.id) filter (where s.status = 'draft')::int as draft,
			count(s.id) filter (where s.status = 'revised')::int as revised,
			count(s.id) filter (where s.status = 'final')::int as final
		from stories st
		left join scenes s on s.story_id = st.id and s.deleted_at is null
		where st.universe_id = ${universeId}
		group by st.id
		order by st.position_in_series asc nulls last, st.created_at asc
	`);
	return result.rows.map((row) => {
		const r = row as {
			id: string;
			slug: string;
			title: string;
			scene_count: number;
			words: number;
			outline: number;
			draft: number;
			revised: number;
			final: number;
		};
		return {
			id: r.id,
			slug: r.slug,
			title: r.title,
			words: r.words,
			sceneCount: r.scene_count,
			status: storyStatus({
				sceneCount: r.scene_count,
				words: r.words,
				outline: r.outline,
				draft: r.draft,
				revised: r.revised,
				final: r.final
			})
		};
	});
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	// The entity lists do not depend on the selection; resolve the selected
	// entity (if the URL names one) alongside them.
	const entityId = url.searchParams.get('entity');
	const [lists, resolved] = await Promise.all([
		planEntityLists(db, universe.id),
		entityId ? resolvePlanEntity(db, universe.id, entityId) : Promise.resolve(null)
	]);
	const selected = resolved?.entity ?? null;
	const selectedKind: EntityKind = resolved?.kind ?? 'character';

	// The open entity's timeline target, if any. Selection above already
	// enforced ownership.
	const revisionTarget: { type: RevisionEntityType; id: string } | null = selected
		? { type: selectedKind === 'lore' ? 'lore_entry' : selectedKind, id: selected.id }
		: null;
	const revisionId = url.searchParams.get('revision');

	// Everything below depends only on the selection resolved above, and the
	// "Appears in" / relationship / revision panels and the no-selection story
	// board are mutually exclusive, so run them together.
	const [
		relationTypes,
		appearsIn,
		mentionTotal,
		relationships,
		revisionRows,
		revisionPreview,
		storyBoard
	] = await Promise.all([
		listRelationTypes(db, universe.id),
		selected
			? entityAppearances(db, { kind: selectedKind, id: selected.id }, { universeId: universe.id })
			: Promise.resolve([] as PlanAppearance[]),
		selected
			? entityMentionCount(db, { kind: selectedKind, id: selected.id }, universe.id)
			: Promise.resolve(0),
		selected
			? listEntityRelationships(db, universe.id, { kind: selectedKind, id: selected.id })
			: Promise.resolve([] as RelationshipView[]),
		revisionTarget
			? listRevisions(db, revisionTarget.type, revisionTarget.id)
			: Promise.resolve([] as RevisionRow[]),
		revisionTarget && revisionId
			? getRevision(db, revisionId, revisionTarget.type, revisionTarget.id).then((r) => r ?? null)
			: Promise.resolve(null),
		selected ? Promise.resolve([] as StoryBoardRow[]) : loadStoryBoard(universe.id)
	]);

	return {
		universe,
		...lists,
		storyBoard,
		selected,
		selectedKind,
		assetsConfigured: (await effectiveAssetConfig(db)) !== null,
		appearsIn,
		mentionTotal,
		relationTypes,
		relationships,
		revisionTarget,
		revisionRows,
		revisionPreview
	};
};

export const actions: Actions = {
	...planActions(async ({ params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		return {
			universeId: universe.id,
			ownerId: locals.user!.id,
			planPath: `/universes/${universe.slug}/plan`
		};
	}),
	// The board's new-story form, so a fresh universe can grow its first
	// story without a detour through the library.
	createStory: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const title = String((await request.formData()).get('title') ?? '').trim();
		if (!title) return fail(400, { scope: 'story', message: 'Give the story a title.' });
		const story = await createStoryInUniverse(db, locals.user!.id, universe.id, title);
		redirect(303, `/stories/${story.slug}`);
	}
};
