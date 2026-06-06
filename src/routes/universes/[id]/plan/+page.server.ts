import { sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { storyStatus } from '$lib/dashboard';
import { ownedUniverse } from '$lib/server/universe-access';
import { planActions } from '$lib/server/plan-actions';
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

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	const lists = await planEntityLists(db, universe.id);

	const entityId = url.searchParams.get('entity');
	let selected = null;
	let selectedKind: EntityKind = 'character';
	if (entityId) {
		const resolved = await resolvePlanEntity(db, universe.id, entityId);
		if (resolved) {
			selected = resolved.entity;
			selectedKind = resolved.kind;
		}
	}

	// Every mention of the selected entity across the universe's stories,
	// for the "Appears in" panel. Grouped by story, then scene, in the page.
	let appearsIn: PlanAppearance[] = [];
	let mentionTotal = 0;
	if (selected) {
		appearsIn = await entityAppearances(
			db,
			{ kind: selectedKind, id: selected.id },
			{ universeId: universe.id }
		);
		mentionTotal = await entityMentionCount(
			db,
			{ kind: selectedKind, id: selected.id },
			universe.id
		);
	}

	// With nothing selected the centre shows the story board: each story
	// in a lane for its derived status, the same derivation as the
	// library's pill.
	let storyBoard: {
		id: string;
		slug: string;
		title: string;
		status: ReturnType<typeof storyStatus>;
		words: number;
		sceneCount: number;
	}[] = [];
	if (!selected) {
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
			where st.universe_id = ${universe.id}
			group by st.id
			order by st.position_in_series asc nulls last, st.created_at asc
		`);
		storyBoard = result.rows.map((row) => {
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

	const relationTypes = await listRelationTypes(db, universe.id);
	let relationships: RelationshipView[] = [];
	if (selected) {
		relationships = await listEntityRelationships(db, universe.id, {
			kind: selectedKind,
			id: selected.id
		});
	}

	// The open entity's timeline, and the previewed revision if the URL
	// names one. Selection above already enforced ownership.
	const revisionTarget: { type: RevisionEntityType; id: string } | null = selected
		? { type: selectedKind === 'lore' ? 'lore_entry' : selectedKind, id: selected.id }
		: null;
	let revisionRows: RevisionRow[] = [];
	let revisionPreview = null;
	if (revisionTarget) {
		revisionRows = await listRevisions(db, revisionTarget.type, revisionTarget.id);
		const revisionId = url.searchParams.get('revision');
		if (revisionId) {
			revisionPreview =
				(await getRevision(db, revisionId, revisionTarget.type, revisionTarget.id)) ?? null;
		}
	}

	return {
		universe,
		user: locals.user!,
		...lists,
		storyBoard,
		selected,
		selectedKind,
		appearsIn,
		mentionTotal,
		relationTypes,
		relationships,
		revisionTarget,
		revisionRows,
		revisionPreview
	};
};

export const actions: Actions = planActions(async ({ params, locals }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	return {
		universeId: universe.id,
		ownerId: locals.user!.id,
		planPath: `/universes/${universe.slug}/plan`
	};
});
