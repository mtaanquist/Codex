import { fail, redirect } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	chapters,
	characterStoryNotes,
	loreStoryNotes,
	outlineNodes,
	placeStoryNotes,
	scenes
} from '$lib/server/db/schema';
import { ownedStory } from '$lib/server/story-access';
import { planActions } from '$lib/server/plan-actions';
import { createOutlineNode, listOutline } from '$lib/server/outline';
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

	// The story's outline, and the chapters and scenes a node can link to.
	const outline = await listOutline(db, story.id);
	const nodeId = url.searchParams.get('node');
	let selectedNode = null;
	if (nodeId && !selected) {
		const [nodeRow] = await db
			.select()
			.from(outlineNodes)
			.where(and(eq(outlineNodes.id, nodeId), eq(outlineNodes.storyId, story.id)));
		selectedNode = nodeRow ?? null;
	}
	const chapterList = await db
		.select({ id: chapters.id, title: chapters.title })
		.from(chapters)
		.where(eq(chapters.storyId, story.id))
		.orderBy(asc(chapters.position));
	const sceneList = await db
		.select({ id: scenes.id, title: scenes.title })
		.from(scenes)
		.where(eq(scenes.storyId, story.id))
		.orderBy(asc(scenes.globalPosition));

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
		relationships,
		outline,
		selectedNode,
		chapters: chapterList,
		scenes: sceneList
	};
};

export const actions: Actions = {
	...planActions(async ({ params, locals }) => {
		const { story, universe } = await ownedStory(params.id, locals.user!.id);
		return {
			universeId: universe.id,
			ownerId: locals.user!.id,
			planPath: `/stories/${story.id}/plan`
		};
	}),
	createOutlineNode: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		if (!title) {
			return fail(400, { kind: 'outline', message: 'Give the node a title.' });
		}
		const node = await createOutlineNode(db, story.id, title);
		redirect(303, `/stories/${story.id}/plan?node=${node.id}`);
	}
};
