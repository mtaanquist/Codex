import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { scheduleObjectDeletions } from './assets.ts';
import {
	assistantChatMessages,
	assistantChatSummaries,
	chapters,
	characterStoryMemberships,
	characterStoryNotes,
	entityMentions,
	entityRelationships,
	exportArtifacts,
	loreStoryNotes,
	notes,
	placeStoryMemberships,
	placeStoryNotes,
	publicationAssets,
	publications,
	reviewComments,
	reviewers,
	reviewInvitations,
	reviewSuggestions,
	reviewThreads,
	revisions,
	sceneMarkers,
	scenes,
	stories
} from './db/schema.ts';

// The transaction handle drizzle passes to db.transaction's callback.
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

// Deletes a story and everything scoped to it, child-first, within a caller's
// transaction. Universe-scoped entities (characters, places, lore) are not the
// story's to delete; only the per-story overlays, memberships, and story-scoped
// relationship rows go. Shared by deleteStory and the account purge.
export async function deleteStoryWithin(tx: Tx, storyId: string): Promise<void> {
	const sceneRows = await tx
		.select({ id: scenes.id })
		.from(scenes)
		.where(eq(scenes.storyId, storyId));
	const chapterRows = await tx
		.select({ id: chapters.id })
		.from(chapters)
		.where(eq(chapters.storyId, storyId));
	const pubRows = await tx
		.select({ id: publications.id })
		.from(publications)
		.where(eq(publications.storyId, storyId));

	const sceneIds = sceneRows.map((row) => row.id);
	const pubIds = pubRows.map((row) => row.id);
	// Revisions and mentions are polymorphic (no FK); match by the ids of
	// this story's revisable items and scenes.
	const revisableIds = [...sceneIds, ...chapterRows.map((r) => r.id)];

	if (pubIds.length > 0) {
		await tx.delete(publicationAssets).where(inArray(publicationAssets.publicationId, pubIds));
	}
	await tx.delete(publications).where(eq(publications.storyId, storyId));

	// Review rows before revisions and scenes: threads and suggestions
	// reference both, and guests are personal data that goes with the story.
	// Threads go first: a suggestion's discussion thread references it.
	const threadRows = await tx
		.select({ id: reviewThreads.id })
		.from(reviewThreads)
		.where(eq(reviewThreads.storyId, storyId));
	if (threadRows.length > 0) {
		await tx.delete(reviewComments).where(
			inArray(
				reviewComments.threadId,
				threadRows.map((row) => row.id)
			)
		);
	}
	await tx.delete(reviewThreads).where(eq(reviewThreads.storyId, storyId));
	await tx.delete(reviewSuggestions).where(eq(reviewSuggestions.storyId, storyId));
	const invitationRows = await tx
		.select({ id: reviewInvitations.id })
		.from(reviewInvitations)
		.where(eq(reviewInvitations.storyId, storyId));
	if (invitationRows.length > 0) {
		await tx.delete(reviewers).where(
			inArray(
				reviewers.invitationId,
				invitationRows.map((row) => row.id)
			)
		);
	}
	await tx.delete(reviewInvitations).where(eq(reviewInvitations.storyId, storyId));

	// The Assistant chat transcripts on this story.
	await tx.delete(assistantChatMessages).where(eq(assistantChatMessages.storyId, storyId));
	await tx.delete(assistantChatSummaries).where(eq(assistantChatSummaries.storyId, storyId));

	if (sceneIds.length > 0) {
		await tx.delete(sceneMarkers).where(inArray(sceneMarkers.sceneId, sceneIds));
		await tx
			.delete(entityMentions)
			.where(
				and(eq(entityMentions.sourceType, 'scene'), inArray(entityMentions.sourceId, sceneIds))
			);
	}
	if (revisableIds.length > 0) {
		await tx.delete(revisions).where(inArray(revisions.entityId, revisableIds));
	}

	// Freeform story notes and their polymorphic revisions. A note can point at
	// a scene, so notes go before scenes.
	const noteRows = await tx.select({ id: notes.id }).from(notes).where(eq(notes.storyId, storyId));
	if (noteRows.length > 0) {
		await tx.delete(revisions).where(
			and(
				eq(revisions.entityType, 'note'),
				inArray(
					revisions.entityId,
					noteRows.map((row) => row.id)
				)
			)
		);
		await tx.delete(notes).where(eq(notes.storyId, storyId));
	}

	// Scenes reference chapters, so scenes first.
	await tx.delete(scenes).where(eq(scenes.storyId, storyId));
	await tx.delete(chapters).where(eq(chapters.storyId, storyId));

	await tx.delete(characterStoryNotes).where(eq(characterStoryNotes.storyId, storyId));
	await tx.delete(loreStoryNotes).where(eq(loreStoryNotes.storyId, storyId));
	await tx.delete(placeStoryNotes).where(eq(placeStoryNotes.storyId, storyId));
	await tx.delete(characterStoryMemberships).where(eq(characterStoryMemberships.storyId, storyId));
	await tx.delete(placeStoryMemberships).where(eq(placeStoryMemberships.storyId, storyId));
	// Only story-scoped relationship rows; universe-wide rows (story_id null)
	// belong to the universe and stay.
	await tx.delete(entityRelationships).where(eq(entityRelationships.storyId, storyId));

	await tx.delete(stories).where(eq(stories.id, storyId));
}

// Deletes a story the user owns, in one transaction. Without this a story with
// any content cannot be deleted at all (the FKs are ON DELETE NO ACTION).
export async function deleteStory(db: Database, storyId: string, userId: string): Promise<boolean> {
	const [story] = await db
		.select({ id: stories.id })
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
	if (!story) return false;
	await purgeStory(db, story.id);
	return true;
}

// Hard-deletes a story with no owner check, for the trash purge. The stored
// export files of the story's editions, whose rows cascade away with the
// publications, are queued for the deferred object sweep.
export async function purgeStory(db: Database, storyId: string): Promise<void> {
	await db.transaction(async (tx) => {
		// Capture the edition export keys before the rows cascade away.
		const artifactRows = await tx
			.select({ storageKey: exportArtifacts.storageKey })
			.from(exportArtifacts)
			.innerJoin(publications, eq(exportArtifacts.publicationId, publications.id))
			.where(eq(publications.storyId, storyId));
		await deleteStoryWithin(tx, storyId);
		await scheduleObjectDeletions(
			tx,
			artifactRows.map((row) => row.storageKey)
		);
	});
}
