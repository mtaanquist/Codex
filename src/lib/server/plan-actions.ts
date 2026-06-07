import { fail, redirect } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { db } from './db';
import { isCategoryColor } from '$lib/entity-color';
import { CATEGORY_NAME_MAX } from './categories';
import {
	characters,
	characterStoryMemberships,
	entityCategories,
	loreEntries,
	places,
	placeStoryMemberships
} from './db/schema';

type PlanScope = {
	universeId: string;
	ownerId: string;
	// Where the page lives, for redirecting to the entity just created.
	planPath: string;
	// At story scope, a created character or place is declared a member of
	// the story right away.
	storyId?: string;
};

// The structural slice of the route's RequestEvent the actions need; both
// plan routes have an [id] param.
type PlanEvent = {
	request: Request;
	params: { id: string };
	locals: App.Locals;
};

// The create actions behind a Plan sidebar, shared by the story and
// universe scopes. resolveScope owns the access check and 404s on a
// foreign id; the actions themselves only differ by scope.
export function planActions(resolveScope: (event: PlanEvent) => Promise<PlanScope>) {
	return {
		createCharacter: async (event: PlanEvent) => {
			const scope = await resolveScope(event);
			const data = await event.request.formData();
			const name = String(data.get('name') ?? '').trim();
			if (!name) {
				return fail(400, { kind: 'character', message: 'Give the character a name.' });
			}
			const [character] = await db
				.insert(characters)
				.values({ universeId: scope.universeId, ownerId: scope.ownerId, name })
				.returning({ id: characters.id });
			if (scope.storyId) {
				await db
					.insert(characterStoryMemberships)
					.values({ characterId: character.id, storyId: scope.storyId });
			}
			redirect(303, `${scope.planPath}?entity=${character.id}`);
		},
		createPlace: async (event: PlanEvent) => {
			const scope = await resolveScope(event);
			const data = await event.request.formData();
			const name = String(data.get('name') ?? '').trim();
			if (!name) {
				return fail(400, { kind: 'place', message: 'Give the place a name.' });
			}
			const [place] = await db
				.insert(places)
				.values({ universeId: scope.universeId, ownerId: scope.ownerId, name })
				.returning({ id: places.id });
			if (scope.storyId) {
				await db
					.insert(placeStoryMemberships)
					.values({ placeId: place.id, storyId: scope.storyId });
			}
			redirect(303, `${scope.planPath}?entity=${place.id}`);
		},
		createLoreEntry: async (event: PlanEvent) => {
			const scope = await resolveScope(event);
			const data = await event.request.formData();
			const title = String(data.get('name') ?? '').trim();
			const categoryId = String(data.get('categoryId') ?? '');
			if (!title) {
				return fail(400, { kind: 'lore', message: 'Give the entry a title.' });
			}
			const [category] = await db
				.select({ id: entityCategories.id })
				.from(entityCategories)
				.where(
					and(
						eq(entityCategories.id, categoryId),
						eq(entityCategories.universeId, scope.universeId)
					)
				);
			if (!category) {
				return fail(400, { kind: 'lore', message: 'That category does not exist.' });
			}
			const [entry] = await db
				.insert(loreEntries)
				.values({ universeId: scope.universeId, ownerId: scope.ownerId, categoryId, title })
				.returning({ id: loreEntries.id });
			redirect(303, `${scope.planPath}?entity=${entry.id}`);
		},
		createCategory: async (event: PlanEvent) => {
			const scope = await resolveScope(event);
			const data = await event.request.formData();
			const name = String(data.get('name') ?? '').trim();
			const color = String(data.get('color') ?? '') || null;
			if (!name) {
				return fail(400, { kind: 'category', message: 'Give the category a name.' });
			}
			if (name.length > CATEGORY_NAME_MAX) {
				return fail(400, {
					kind: 'category',
					message: 'Category names can be at most 60 characters.'
				});
			}
			if (!isCategoryColor(color)) {
				return fail(400, { kind: 'category', message: 'Pick a colour from the list.' });
			}
			await db.insert(entityCategories).values({
				universeId: scope.universeId,
				ownerId: scope.ownerId,
				name,
				color,
				// Computed inside the insert so concurrent creates cannot collide.
				sortOrder: sql<number>`(select coalesce(max(${entityCategories.sortOrder}), 0) + 1 from ${entityCategories} where ${entityCategories.universeId} = ${scope.universeId})`
			});
			return { kind: 'category', created: true };
		}
	};
}
