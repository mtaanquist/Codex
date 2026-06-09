import { fail, redirect } from '@sveltejs/kit';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { effectiveAssetConfig } from '$lib/server/assets';
import {
	chapters,
	characterStoryNotes,
	loreStoryNotes,
	placeStoryNotes,
	sceneMarkers,
	scenes
} from '$lib/server/db/schema';
import { ownedStory } from '$lib/server/story-access';
import { planActions } from '$lib/server/plan-actions';
import {
	declareMembership,
	membershipStatus,
	storyEntityLists,
	type MembershipStatus
} from '$lib/server/membership';
import {
	getRevision,
	listRevisions,
	type RevisionEntityType,
	type RevisionRow
} from '$lib/server/revisions';
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
import { assistantLayout } from '$lib/server/llm/config';
import { listPendingForEntity, type EntitySuggestion } from '$lib/server/entity-suggestions';
import type { EntityKind } from '$lib/components/EntityEditor.svelte';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);

	// The sidebar shows the story's cast: declared members plus anyone
	// mentioned in its prose. The full universe lists feed the "add an
	// existing entity" selects and the relationship targets. Lore stays
	// universe-wide; it has no membership.
	const universeLists = await planEntityLists(db, universe.id);
	const storyLists = await storyEntityLists(db, universe.id, story.id);
	const inStory = new Set([...storyLists.characters, ...storyLists.places].map((row) => row.id));
	const lists = {
		...universeLists,
		...storyLists,
		universeCharacters: universeLists.characters,
		universePlaces: universeLists.places,
		availableCharacters: universeLists.characters.filter((row) => !inStory.has(row.id)),
		availablePlaces: universeLists.places.filter((row) => !inStory.has(row.id))
	};

	const entityId = url.searchParams.get('entity');
	let selected = null;
	let selectedKind: EntityKind = 'character';
	let storyNotesMd = '';
	if (entityId) {
		const resolved = await resolvePlanEntity(db, universe.id, entityId);
		if (resolved) {
			selected = resolved.entity;
			selectedKind = resolved.kind;
			// The per-story "In this book" notes live in a table per kind.
			let notes: { notesMd: string } | undefined;
			if (resolved.kind === 'character') {
				[notes] = await db
					.select({ notesMd: characterStoryNotes.notesMd })
					.from(characterStoryNotes)
					.where(
						and(
							eq(characterStoryNotes.characterId, resolved.entity.id),
							eq(characterStoryNotes.storyId, story.id)
						)
					);
			} else if (resolved.kind === 'place') {
				[notes] = await db
					.select({ notesMd: placeStoryNotes.notesMd })
					.from(placeStoryNotes)
					.where(
						and(
							eq(placeStoryNotes.placeId, resolved.entity.id),
							eq(placeStoryNotes.storyId, story.id)
						)
					);
			} else {
				[notes] = await db
					.select({ notesMd: loreStoryNotes.notesMd })
					.from(loreStoryNotes)
					.where(
						and(
							eq(loreStoryNotes.loreEntryId, resolved.entity.id),
							eq(loreStoryNotes.storyId, story.id)
						)
					);
			}
			storyNotesMd = notes?.notesMd ?? '';
		}
	}

	// Every mention of the selected entity in this story, for the
	// "Appears in" panel. Grouped by scene in the page.
	let appearsIn: PlanAppearance[] = [];
	let mentionTotal = 0;
	if (selected) {
		appearsIn = await entityAppearances(
			db,
			{ kind: selectedKind, id: selected.id },
			{ storyId: story.id }
		);
		mentionTotal = await entityMentionCount(
			db,
			{ kind: selectedKind, id: selected.id },
			universe.id
		);
	}

	const relationTypes = await listRelationTypes(db, universe.id);
	let relationships: RelationshipView[] = [];
	let membership: MembershipStatus | null = null;
	if (selected) {
		relationships = await listEntityRelationships(db, universe.id, {
			kind: selectedKind,
			id: selected.id
		});
		if (selectedKind !== 'lore') {
			membership = await membershipStatus(db, selectedKind, selected.id, story.id);
		}
	}

	// The Assistant can enrich the open entity (suggest aliases, details, a
	// summary) when it is on for this story; its pending suggestions ride along.
	const assistant = await assistantLayout(db, locals.user!.id, story.id);
	let assistantSuggestions: EntitySuggestion[] = [];
	if (selected) {
		assistantSuggestions = await listPendingForEntity(
			db,
			locals.user!.id,
			selectedKind,
			selected.id
		);
	}

	const chapterList = await db
		.select({ id: chapters.id, title: chapters.title })
		.from(chapters)
		.where(eq(chapters.storyId, story.id))
		.orderBy(asc(chapters.position));
	// Full rows for the scene board.
	const sceneList = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			status: scenes.status,
			wordCount: scenes.wordCount,
			chapterId: scenes.chapterId
		})
		.from(scenes)
		.where(and(eq(scenes.storyId, story.id), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));
	// Open TODOs per scene, shown on the board cards.
	const todoRows = await db
		.select({ sceneId: sceneMarkers.sceneId, todos: count() })
		.from(sceneMarkers)
		.innerJoin(scenes, eq(sceneMarkers.sceneId, scenes.id))
		.where(
			and(
				eq(scenes.storyId, story.id),
				isNull(scenes.deletedAt),
				eq(sceneMarkers.kind, 'todo'),
				isNull(sceneMarkers.resolvedAt)
			)
		)
		.groupBy(sceneMarkers.sceneId);
	const todoCounts = Object.fromEntries(todoRows.map((row) => [row.sceneId, row.todos]));

	// The open item's timeline, and the previewed revision if the URL
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
		story,
		universe,
		...lists,
		selected,
		selectedKind,
		assetsConfigured: (await effectiveAssetConfig(db)) !== null,
		storyNotesMd,
		appearsIn,
		mentionTotal,
		relationTypes,
		relationships,
		membership,
		chapters: chapterList,
		scenes: sceneList,
		todoCounts,
		revisionTarget,
		revisionRows,
		revisionPreview,
		assistantEnabled: assistant.surfacesEnabled,
		assistantSuggestions
	};
};

export const actions: Actions = {
	...planActions(async ({ params, locals }) => {
		const { story, universe } = await ownedStory(params.id, locals.user!.id);
		return {
			universeId: universe.id,
			ownerId: locals.user!.id,
			planPath: `/stories/${story.slug}/plan`,
			storyId: story.id
		};
	}),
	declareMember: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const kind = String(data.get('kind') ?? '');
		const entityId = String(data.get('entityId') ?? '');
		if ((kind !== 'character' && kind !== 'place') || !entityId) {
			return fail(400, { kind: 'member', message: 'Pick an entity to add.' });
		}
		const result = await declareMembership(db, locals.user!.id, kind, entityId, story.id);
		if (!result.ok) {
			return fail(400, { kind: 'member', message: result.reason });
		}
		redirect(303, `/stories/${story.slug}/plan?entity=${entityId}`);
	}
};
