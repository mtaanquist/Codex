import { fail, redirect } from '@sveltejs/kit';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	characters,
	characterStoryNotes,
	entityCategories,
	entityMentions,
	loreEntries,
	loreStoryNotes,
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
		.select({ id: characters.id, name: characters.name, color: entityCategories.color })
		.from(characters)
		.leftJoin(entityCategories, eq(characters.categoryId, entityCategories.id))
		.where(eq(characters.universeId, universe.id))
		.orderBy(asc(characters.name));
	const placeList = await db
		.select({ id: places.id, name: places.name, color: entityCategories.color })
		.from(places)
		.leftJoin(entityCategories, eq(places.categoryId, entityCategories.id))
		.where(eq(places.universeId, universe.id))
		.orderBy(asc(places.name));
	const categories = await db
		.select({
			id: entityCategories.id,
			name: entityCategories.name,
			color: entityCategories.color
		})
		.from(entityCategories)
		.where(eq(entityCategories.universeId, universe.id))
		.orderBy(asc(entityCategories.sortOrder), asc(entityCategories.name));
	const loreList = await db
		.select({ id: loreEntries.id, name: loreEntries.title, categoryId: loreEntries.categoryId })
		.from(loreEntries)
		.where(eq(loreEntries.universeId, universe.id))
		.orderBy(asc(loreEntries.title));

	const entityId = url.searchParams.get('entity');
	let selected = null;
	let selectedKind: EntityKind = 'character';
	let storyNotesMd = '';
	if (entityId) {
		const [characterRow] = await db
			.select()
			.from(characters)
			.where(and(eq(characters.id, entityId), eq(characters.universeId, universe.id)));
		const [placeRow] = characterRow
			? [undefined]
			: await db
					.select()
					.from(places)
					.where(and(eq(places.id, entityId), eq(places.universeId, universe.id)));
		const [loreRow] =
			characterRow || placeRow
				? [undefined]
				: await db
						.select()
						.from(loreEntries)
						.where(and(eq(loreEntries.id, entityId), eq(loreEntries.universeId, universe.id)));

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
		} else if (placeRow) {
			selected = placeRow;
			selectedKind = 'place';
			const [notes] = await db
				.select({ notesMd: placeStoryNotes.notesMd })
				.from(placeStoryNotes)
				.where(
					and(eq(placeStoryNotes.placeId, placeRow.id), eq(placeStoryNotes.storyId, story.id))
				);
			storyNotesMd = notes?.notesMd ?? '';
		} else if (loreRow) {
			selected = { ...loreRow, name: loreRow.title };
			selectedKind = 'lore';
			const [notes] = await db
				.select({ notesMd: loreStoryNotes.notesMd })
				.from(loreStoryNotes)
				.where(
					and(eq(loreStoryNotes.loreEntryId, loreRow.id), eq(loreStoryNotes.storyId, story.id))
				);
			storyNotesMd = notes?.notesMd ?? '';
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
		const targetType = selectedKind === 'lore' ? 'lore_entry' : selectedKind;
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
					eq(entityMentions.targetType, targetType),
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
		categories,
		lore: loreList,
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
	},
	createLoreEntry: async ({ request, params, locals }) => {
		const { story, universe } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const title = String(data.get('name') ?? '').trim();
		const categoryId = String(data.get('categoryId') ?? '');
		if (!title) {
			return fail(400, { kind: 'lore', message: 'Give the entry a title.' });
		}
		const [category] = await db
			.select({ id: entityCategories.id })
			.from(entityCategories)
			.where(
				and(eq(entityCategories.id, categoryId), eq(entityCategories.universeId, universe.id))
			);
		if (!category) {
			return fail(400, { kind: 'lore', message: 'That category does not exist.' });
		}
		const [entry] = await db
			.insert(loreEntries)
			.values({ universeId: universe.id, ownerId: locals.user!.id, categoryId, title })
			.returning({ id: loreEntries.id });
		redirect(303, `/stories/${story.id}/plan?entity=${entry.id}`);
	},
	createCategory: async ({ request, params, locals }) => {
		const { universe } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const color = String(data.get('color') ?? '') || null;
		if (!name) {
			return fail(400, { kind: 'category', message: 'Give the category a name.' });
		}
		await db.insert(entityCategories).values({
			universeId: universe.id,
			ownerId: locals.user!.id,
			name,
			color,
			// Computed inside the insert so concurrent creates cannot collide.
			sortOrder: sql<number>`(select coalesce(max(${entityCategories.sortOrder}), 0) + 1 from ${entityCategories} where ${entityCategories.universeId} = ${universe.id})`
		});
		return { kind: 'category', created: true };
	}
};
