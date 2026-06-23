import { and, asc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../auth';
import { assistantChatMessages, type AssistantChatMeta } from '../db/schema';

// The persisted Assistant conversation: one transcript per scope per user,
// loaded when the surface opens and appended as turns complete. The scope is a
// story (the Write/Review/story-Plan thread) or a universe (the universe-Plan
// thread); a row is keyed to exactly one. The synthesized opening line is never
// stored; references and split proposals ride in meta so the panel can rebuild
// its chips and cards after a reload.

// Keeps a conversation from growing without bound; the oldest turns drop on
// append, like a scrollback buffer.
const MAX_TURNS = 200;

// Which conversation a turn belongs to: a story or a universe, never both. The
// schema CHECK enforces the exclusive or; this type keeps the callers honest.
export type ChatScope = { storyId: string } | { universeId: string };

// The WHERE clause for a scope, paired with the per-user filter at each call.
function scopeWhere(scope: ChatScope): SQL {
	return 'storyId' in scope
		? eq(assistantChatMessages.storyId, scope.storyId)
		: eq(assistantChatMessages.universeId, scope.universeId);
}

// The story_id/universe_id pair an insert sets: one column, the other null.
function scopeValues(scope: ChatScope): { storyId: string | null; universeId: string | null } {
	return 'storyId' in scope
		? { storyId: scope.storyId, universeId: null }
		: { storyId: null, universeId: scope.universeId };
}

export type StoredChatMessage = {
	role: 'user' | 'assistant';
	content: string;
	meta: AssistantChatMeta | null;
};

export async function listChat(
	db: Database,
	userId: string,
	scope: ChatScope
): Promise<StoredChatMessage[]> {
	const rows = await db
		.select({
			role: assistantChatMessages.role,
			content: assistantChatMessages.content,
			meta: assistantChatMessages.meta
		})
		.from(assistantChatMessages)
		.where(and(eq(assistantChatMessages.userId, userId), scopeWhere(scope)))
		.orderBy(asc(assistantChatMessages.createdAt));
	return rows;
}

export async function appendChat(
	db: Database,
	userId: string,
	scope: ChatScope,
	message: StoredChatMessage
): Promise<void> {
	if (!message.content.trim() && !message.meta) return;
	await db.insert(assistantChatMessages).values({
		...scopeValues(scope),
		userId,
		role: message.role,
		content: message.content,
		meta: message.meta
	});
	// Trim the scrollback: everything older than the newest MAX_TURNS rows.
	const cutoff = await db
		.select({ createdAt: assistantChatMessages.createdAt })
		.from(assistantChatMessages)
		.where(and(eq(assistantChatMessages.userId, userId), scopeWhere(scope)))
		.orderBy(sql`${assistantChatMessages.createdAt} desc`)
		.offset(MAX_TURNS - 1)
		.limit(1);
	if (cutoff.length > 0) {
		await db
			.delete(assistantChatMessages)
			.where(
				and(
					eq(assistantChatMessages.userId, userId),
					scopeWhere(scope),
					lt(assistantChatMessages.createdAt, cutoff[0].createdAt)
				)
			);
	}
}

// Marks a stored split proposal as confirmed (recording what the split
// created) or clears that mark after a revert, so the card's state survives
// a reload. The proposal is matched by its scene and passage across the
// user's conversation for the scope; every match updates, so a re-proposed
// point stays consistent. Returns whether anything matched.
export async function setProposalConfirmed(
	db: Database,
	userId: string,
	scope: ChatScope,
	key: { sceneId: string; before: string },
	confirmed: { splitSceneId: string; newSceneId: string } | null
): Promise<boolean> {
	const rows = await db
		.select({ id: assistantChatMessages.id, meta: assistantChatMessages.meta })
		.from(assistantChatMessages)
		.where(and(eq(assistantChatMessages.userId, userId), scopeWhere(scope)));
	let matched = false;
	for (const row of rows) {
		if (!row.meta?.proposals?.some((p) => p.sceneId === key.sceneId && p.before === key.before)) {
			continue;
		}
		matched = true;
		const proposals = row.meta.proposals.map((p) =>
			p.sceneId === key.sceneId && p.before === key.before
				? { ...p, confirmed: confirmed ?? undefined }
				: p
		);
		await db
			.update(assistantChatMessages)
			.set({ meta: { ...row.meta, proposals } })
			.where(eq(assistantChatMessages.id, row.id));
	}
	return matched;
}

export async function clearChat(db: Database, userId: string, scope: ChatScope): Promise<void> {
	await db
		.delete(assistantChatMessages)
		.where(and(eq(assistantChatMessages.userId, userId), scopeWhere(scope)));
}

// The delete cascades reach for these: a story's transcripts go with the
// story (every user's, not just the owner's - the rows are story-bound), and
// an account purge clears the user's transcripts everywhere.
export async function deleteChatForStories(db: Database, storyIds: string[]): Promise<void> {
	if (storyIds.length === 0) return;
	await db.delete(assistantChatMessages).where(inArray(assistantChatMessages.storyId, storyIds));
}

export async function deleteChatForUser(db: Database, userId: string): Promise<void> {
	await db.delete(assistantChatMessages).where(eq(assistantChatMessages.userId, userId));
}
