import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { characterStoryNotes, loreStoryNotes, placeStoryNotes } from '$lib/server/db/schema';
import { ownedStory } from '$lib/server/story-access';
import { planActions } from '$lib/server/plan-actions';
import {
	entityAppearances,
	planEntityLists,
	resolvePlanEntity,
	type PlanAppearance
} from '$lib/server/plan-data';
import {
	listEntityRelationships,
	listRelationTypes,
	type RelationshipView
} from '$lib/server/relationships';
import type { EntityKind } from '$lib/components/EntityEditor.svelte';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);

	// Until declared membership and mention-based filtering exist (step 20),
	// the story's Plan lists every entity in the universe.
	const lists = await planEntityLists(db, universe.id);

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
	if (selected) {
		appearsIn = await entityAppearances(
			db,
			{ kind: selectedKind, id: selected.id },
			{ storyId: story.id }
		);
	}

	const relationTypes = await listRelationTypes(db, universe.id);
	let relationships: RelationshipView[] = [];
	if (selected) {
		relationships = await listEntityRelationships(db, universe.id, {
			kind: selectedKind,
			id: selected.id
		});
	}

	return {
		story,
		universe,
		user: locals.user!,
		...lists,
		selected,
		selectedKind,
		storyNotesMd,
		appearsIn,
		relationTypes,
		relationships
	};
};

export const actions: Actions = planActions(async ({ params, locals }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);
	return {
		universeId: universe.id,
		ownerId: locals.user!.id,
		planPath: `/stories/${story.id}/plan`
	};
});
