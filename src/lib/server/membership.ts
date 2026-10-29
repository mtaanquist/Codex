import { and, asc, eq, exists, or } from 'drizzle-orm';
import type { ActionFailure } from './action-result.ts';
import type { Database } from './auth.ts';
import {
	characterStoryMemberships,
	entityCategories,
	entityMentions,
	placeStoryMemberships,
	scenes,
	stories
} from './db/schema.ts';
import { entityTable } from './entity-lookups.ts';
import { storyIsLive } from './universe-scope.ts';

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
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId), storyIsLive()));
	if (!story) return null;
	const table = entityTable(kind);
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
): Promise<{ ok: true } | ActionFailure> {
	const scope = await ownedStoryEntity(db, userId, kind, entityId, storyId);
	if (!scope)
		return {
			ok: false,
			code: 'not_found',
			reason: 'That character, place or story no longer exists.'
		};
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
): Promise<{ ok: true } | ActionFailure> {
	const scope = await ownedStoryEntity(db, userId, kind, entityId, storyId);
	if (!scope)
		return {
			ok: false,
			code: 'not_found',
			reason: 'That character, place or story no longer exists.'
		};
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
	const memberList = (kind: MemberKind) => {
		const table = entityTable(kind);
		const membership =
			kind === 'character'
				? db
						.select({ one: characterStoryMemberships.characterId })
						.from(characterStoryMemberships)
						.where(
							and(
								eq(characterStoryMemberships.characterId, table.id),
								eq(characterStoryMemberships.storyId, storyId)
							)
						)
				: db
						.select({ one: placeStoryMemberships.placeId })
						.from(placeStoryMemberships)
						.where(
							and(
								eq(placeStoryMemberships.placeId, table.id),
								eq(placeStoryMemberships.storyId, storyId)
							)
						);
		return db
			.select({
				id: table.id,
				name: table.name,
				color: entityCategories.color,
				badgeColor: table.badgeColor,
				badgeAssetId: table.badgeAssetId
			})
			.from(table)
			.leftJoin(entityCategories, eq(table.categoryId, entityCategories.id))
			.where(
				and(
					eq(table.universeId, universeId),
					or(
						exists(membership),
						exists(
							db
								.select({ one: entityMentions.id })
								.from(entityMentions)
								.innerJoin(scenes, eq(entityMentions.sourceId, scenes.id))
								.where(
									and(
										eq(entityMentions.sourceType, 'scene'),
										eq(entityMentions.targetType, kind),
										eq(entityMentions.targetId, table.id),
										eq(scenes.storyId, storyId)
									)
								)
						)
					)
				)
			)
			.orderBy(asc(table.name));
	};
	return { characters: await memberList('character'), places: await memberList('place') };
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
