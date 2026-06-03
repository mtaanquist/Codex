import { fail, redirect } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	characters,
	characterStoryNotes,
	entityMentions,
	places,
	placeStoryNotes,
	scenes
} from '$lib/server/db/schema';
import { ownedStory } from '$lib/server/story-access';
import type { EntityKind } from '$lib/components/EntityEditor.svelte';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);

	// Until declared membership and mention-based filtering exist (step 20),
	// the story's Plan lists every entity in the universe.
	const characterList = await db
		.select({ id: characters.id, name: characters.name })
		.from(characters)
		.where(eq(characters.universeId, universe.id))
		.orderBy(asc(characters.name));
	const placeList = await db
		.select({ id: places.id, name: places.name })
		.from(places)
		.where(eq(places.universeId, universe.id))
		.orderBy(asc(places.name));

	const entityId = url.searchParams.get('entity');
	let selected = null;
	let selectedKind: EntityKind = 'character';
	let storyNotesMd = '';
	if (entityId) {
		const [characterRow] = await db
			.select()
			.from(characters)
			.where(and(eq(characters.id, entityId), eq(characters.universeId, universe.id)));
		if (characterRow) {
			selected = characterRow;
			selectedKind = 'character';
			const [notes] = await db
				.select({ notesMd: characterStoryNotes.notesMd })
				.from(characterStoryNotes)
				.where(
					and(
						eq(characterStoryNotes.characterId, characterRow.id),
						eq(characterStoryNotes.storyId, story.id)
					)
				);
			storyNotesMd = notes?.notesMd ?? '';
		} else {
			const [placeRow] = await db
				.select()
				.from(places)
				.where(and(eq(places.id, entityId), eq(places.universeId, universe.id)));
			if (placeRow) {
				selected = placeRow;
				selectedKind = 'place';
				const [notes] = await db
					.select({ notesMd: placeStoryNotes.notesMd })
					.from(placeStoryNotes)
					.where(
						and(eq(placeStoryNotes.placeId, placeRow.id), eq(placeStoryNotes.storyId, story.id))
					);
				storyNotesMd = notes?.notesMd ?? '';
			}
		}
	}

	// Every mention of the selected entity in this story, for the
	// "Appears in" panel. Grouped by scene in the page.
	let appearsIn: {
		sceneId: string;
		sceneTitle: string | null;
		snippet: string;
	}[] = [];
	if (selected) {
		appearsIn = await db
			.select({
				sceneId: scenes.id,
				sceneTitle: scenes.title,
				snippet: entityMentions.surroundingText
			})
			.from(entityMentions)
			.innerJoin(scenes, eq(entityMentions.sourceId, scenes.id))
			.where(
				and(
					eq(entityMentions.sourceType, 'scene'),
					eq(entityMentions.targetType, selectedKind),
					eq(entityMentions.targetId, selected.id),
					eq(scenes.storyId, story.id)
				)
			)
			.orderBy(asc(scenes.globalPosition), asc(entityMentions.position));
	}

	return {
		story,
		universe,
		user: locals.user!,
		characters: characterList,
		places: placeList,
		selected,
		selectedKind,
		storyNotesMd,
		appearsIn
	};
};

export const actions: Actions = {
	createCharacter: async ({ request, params, locals }) => {
		const { story, universe } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) {
			return fail(400, { kind: 'character', message: 'Give the character a name.' });
		}
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: locals.user!.id, name })
			.returning({ id: characters.id });
		redirect(303, `/stories/${story.id}/plan?entity=${character.id}`);
	},
	createPlace: async ({ request, params, locals }) => {
		const { story, universe } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) {
			return fail(400, { kind: 'place', message: 'Give the place a name.' });
		}
		const [place] = await db
			.insert(places)
			.values({ universeId: universe.id, ownerId: locals.user!.id, name })
			.returning({ id: places.id });
		redirect(303, `/stories/${story.id}/plan?entity=${place.id}`);
	}
};
