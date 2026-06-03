import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { ownedUniverse } from '$lib/server/universe-access';
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
	if (selected) {
		appearsIn = await entityAppearances(
			db,
			{ kind: selectedKind, id: selected.id },
			{ universeId: universe.id }
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
		universe,
		user: locals.user!,
		...lists,
		selected,
		selectedKind,
		appearsIn,
		relationTypes,
		relationships
	};
};

export const actions: Actions = planActions(async ({ params, locals }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	return {
		universeId: universe.id,
		ownerId: locals.user!.id,
		planPath: `/universes/${universe.id}/plan`
	};
});
