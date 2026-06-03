import { fail, redirect } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { characters, characterStoryNotes, entityMentions, scenes } from '$lib/server/db/schema';
import { ownedStory } from '$lib/server/story-access';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);

	// Until declared membership and mentions exist (steps 14 and 20), the
	// story's Plan lists every character in the universe.
	const characterList = await db
		.select({ id: characters.id, name: characters.name })
		.from(characters)
		.where(eq(characters.universeId, universe.id))
		.orderBy(asc(characters.name));

	const entityId = url.searchParams.get('entity');
	let selected = null;
	let storyNotesMd = '';
	if (entityId) {
		const [row] = await db
			.select()
			.from(characters)
			.where(and(eq(characters.id, entityId), eq(characters.universeId, universe.id)));
		selected = row ?? null;
		if (selected) {
			const [notes] = await db
				.select({ notesMd: characterStoryNotes.notesMd })
				.from(characterStoryNotes)
				.where(
					and(
						eq(characterStoryNotes.characterId, selected.id),
						eq(characterStoryNotes.storyId, story.id)
					)
				);
			storyNotesMd = notes?.notesMd ?? '';
		}
	}

	// Every mention of the selected character in this story, for the
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
					eq(entityMentions.targetType, 'character'),
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
		selected,
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
			return fail(400, { message: 'Give the character a name.' });
		}
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: locals.user!.id, name })
			.returning({ id: characters.id });
		redirect(303, `/stories/${story.id}/plan?entity=${character.id}`);
	}
};
