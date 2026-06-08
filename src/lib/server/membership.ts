import { and, asc, eq, exists, or } from 'drizzle-orm';
import type { Database } from './auth';
import {
	characters,
	characterStoryMemberships,
	entityCategories,
	entityMentions,
	places,
	placeStoryMemberships,
	scenes,
	stories
} from './db/schema';

export type MemberKind = 'character' | 'place';

async function ownedStoryEntity(
	db: Database,
	userId: string,
	kind: MemberKind,
	entityId: string,
	storyId: string
) {
	// Entity and story must share a universe the user owns.
	const [story] = await db
		.select({ id: stories.id, universeId: stories.universeId })
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
	if (!story) return null;
	const table = kind === 'character' ? characters : places;
	const [entity] = await db
		.select({ id: table.id })
		.from(table)
		.where(and(eq(table.id, entityId), eq(table.universeId, story.universeId)));
	return entity ? { storyId: story.id, entityId: entity.id } : null;
}

export async function declareMembership(
	db: Database,
	userId: string,
	kind: MemberKind,
	entityId: string,
	storyId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const scope = await ownedStoryEntity(db, userId, kind, entityId, storyId);
	if (!scope) return { ok: false, reason: 'entity or story not found' };
	if (kind === 'character') {
		await db
			.insert(characterStoryMemberships)
			.values({ characterId: entityId, storyId })
			.onConflictDoNothing();
	} else {
		await db
			.insert(placeStoryMemberships)
			.values({ placeId: entityId, storyId })
			.onConflictDoNothing();
	}
	return { ok: true };
}

export async function removeMembership(
	db: Database,
	userId: string,
	kind: MemberKind,
	entityId: string,
	storyId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const scope = await ownedStoryEntity(db, userId, kind, entityId, storyId);
	if (!scope) return { ok: false, reason: 'entity or story not found' };
	if (kind === 'character') {
		await db
			.delete(characterStoryMemberships)
			.where(
				and(
					eq(characterStoryMemberships.characterId, entityId),
					eq(characterStoryMemberships.storyId, storyId)
				)
			);
	} else {
		await db
			.delete(placeStoryMemberships)
			.where(
				and(eq(placeStoryMemberships.placeId, entityId), eq(placeStoryMemberships.storyId, storyId))
			);
	}
	return { ok: true };
}

// The story Plan's character and place lists: universe entities that are
// declared members of, or mentioned in, the story. Membership is the
// explicit signal; mentions are the derived one.
export async function storyEntityLists(db: Database, universeId: string, storyId: string) {
	const characterList = await db
		.select({
			id: characters.id,
			name: characters.name,
			color: entityCategories.color,
			badgeColor: characters.badgeColor,
			badgeAssetId: characters.badgeAssetId
		})
		.from(characters)
		.leftJoin(entityCategories, eq(characters.categoryId, entityCategories.id))
		.where(
			and(
				eq(characters.universeId, universeId),
				or(
					exists(
						db
							.select({ one: characterStoryMemberships.characterId })
							.from(characterStoryMemberships)
							.where(
								and(
									eq(characterStoryMemberships.characterId, characters.id),
									eq(characterStoryMemberships.storyId, storyId)
								)
							)
					),
					exists(
						db
							.select({ one: entityMentions.id })
							.from(entityMentions)
							.innerJoin(scenes, eq(entityMentions.sourceId, scenes.id))
							.where(
								and(
									eq(entityMentions.sourceType, 'scene'),
									eq(entityMentions.targetType, 'character'),
									eq(entityMentions.targetId, characters.id),
									eq(scenes.storyId, storyId)
								)
							)
					)
				)
			)
		)
		.orderBy(asc(characters.name));
	const placeList = await db
		.select({
			id: places.id,
			name: places.name,
			color: entityCategories.color,
			badgeColor: places.badgeColor,
			badgeAssetId: places.badgeAssetId
		})
		.from(places)
		.leftJoin(entityCategories, eq(places.categoryId, entityCategories.id))
		.where(
			and(
				eq(places.universeId, universeId),
				or(
					exists(
						db
							.select({ one: placeStoryMemberships.placeId })
							.from(placeStoryMemberships)
							.where(
								and(
									eq(placeStoryMemberships.placeId, places.id),
									eq(placeStoryMemberships.storyId, storyId)
								)
							)
					),
					exists(
						db
							.select({ one: entityMentions.id })
							.from(entityMentions)
							.innerJoin(scenes, eq(entityMentions.sourceId, scenes.id))
							.where(
								and(
									eq(entityMentions.sourceType, 'scene'),
									eq(entityMentions.targetType, 'place'),
									eq(entityMentions.targetId, places.id),
									eq(scenes.storyId, storyId)
								)
							)
					)
				)
			)
		)
		.orderBy(asc(places.name));
	return { characters: characterList, places: placeList };
}

export type MembershipStatus = { member: boolean; mentioned: boolean };

// The selected entity's standing in the story, for the editor's
// "appears in this story" control.
export async function membershipStatus(
	db: Database,
	kind: MemberKind,
	entityId: string,
	storyId: string
): Promise<MembershipStatus> {
	let member: boolean;
	if (kind === 'character') {
		const [row] = await db
			.select({ characterId: characterStoryMemberships.characterId })
			.from(characterStoryMemberships)
			.where(
				and(
					eq(characterStoryMemberships.characterId, entityId),
					eq(characterStoryMemberships.storyId, storyId)
				)
			);
		member = Boolean(row);
	} else {
		const [row] = await db
			.select({ placeId: placeStoryMemberships.placeId })
			.from(placeStoryMemberships)
			.where(
				and(eq(placeStoryMemberships.placeId, entityId), eq(placeStoryMemberships.storyId, storyId))
			);
		member = Boolean(row);
	}
	const [mention] = await db
		.select({ id: entityMentions.id })
		.from(entityMentions)
		.innerJoin(scenes, eq(entityMentions.sourceId, scenes.id))
		.where(
			and(
				eq(entityMentions.sourceType, 'scene'),
				eq(entityMentions.targetType, kind),
				eq(entityMentions.targetId, entityId),
				eq(scenes.storyId, storyId)
			)
		)
		.limit(1);
	return { member, mentioned: Boolean(mention) };
}
