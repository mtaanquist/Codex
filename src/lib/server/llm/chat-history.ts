import { and, asc, desc, eq, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../auth';
import {
	assistantChatMessages,
	assistantChats,
	assistantChatSummaries,
	type AssistantChatMeta
} from '../db/schema';
import {
	readChatSettings,
	type ChatModelInfo,
	type ChatModelSettings,
	type ChatSummary
} from '../../assistant-chat.ts';
import { chatModelInfo, resolveLlmConfig } from './config';
import { isUuid } from '../../slug.ts';
import { estimateTokens } from './context/assemble';
import { CHAT_BUDGET_TOKENS } from './context/budgets';
import type { ChatMessage } from './providers/types';

// The persisted Assistant chats: any number per scope per user, each loaded
// when the writer opens it and appended as turns complete. The scope is a
// story (the Write/Review/story-Plan surfaces) or a universe (universe Plan).
// The synthesized opening line is never stored; references and split proposals
// ride in meta so the panel can rebuild its chips and cards after a reload.

// Keeps a chat from growing without bound; the oldest turns drop on append,
// like a scrollback buffer.
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

function chatScopeWhere(scope: ChatScope): SQL {
	return 'storyId' in scope
		? eq(assistantChats.storyId, scope.storyId)
		: eq(assistantChats.universeId, scope.universeId);
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

// A scope's chats, the most recently used first.
export async function listChats(
	db: Database,
	userId: string,
	scope: ChatScope
): Promise<ChatSummary[]> {
	const rows = await db
		.select({
			id: assistantChats.id,
			title: assistantChats.title,
			updatedAt: assistantChats.updatedAt
		})
		.from(assistantChats)
		.where(and(eq(assistantChats.userId, userId), chatScopeWhere(scope)))
		.orderBy(desc(assistantChats.updatedAt), desc(assistantChats.id));
	return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

// The writer's chat by id, or null when it is not theirs (or does not exist).
export async function getChat(
	db: Database,
	userId: string,
	chatId: string
): Promise<{
	id: string;
	title: string;
	scope: ChatScope;
	settings: ChatModelSettings;
} | null> {
	if (!isUuid(chatId)) return null;
	const [row] = await db
		.select({
			id: assistantChats.id,
			title: assistantChats.title,
			settings: assistantChats.settings,
			storyId: assistantChats.storyId,
			universeId: assistantChats.universeId
		})
		.from(assistantChats)
		.where(and(eq(assistantChats.id, chatId), eq(assistantChats.userId, userId)));
	if (!row) return null;
	return {
		id: row.id,
		title: row.title,
		scope: row.storyId ? { storyId: row.storyId } : { universeId: row.universeId! },
		settings: readChatSettings(row.settings)
	};
}

// Saves the model and effort picked for a chat; an empty setting clears it.
// Only writes when the value changed, so a send that carries the same setting
// as last time costs no write.
export async function setChatSettings(
	db: Database,
	userId: string,
	chatId: string,
	settings: ChatModelSettings
): Promise<void> {
	const value = Object.keys(settings).length > 0 ? settings : null;
	await db
		.update(assistantChats)
		.set({ settings: value })
		.where(
			and(
				eq(assistantChats.id, chatId),
				eq(assistantChats.userId, userId),
				sql`${assistantChats.settings} is distinct from ${value === null ? null : JSON.stringify(value)}::jsonb`
			)
		);
}

function sameScope(a: ChatScope, b: ChatScope): boolean {
	return 'storyId' in a
		? 'storyId' in b && a.storyId === b.storyId
		: 'universeId' in b && a.universeId === b.universeId;
}

// The chat a request continues: the named one when it is the writer's and
// belongs to this scope, or, with no id, a new chat titled from its first
// message. Returns null for an id that is not the writer's chat in this scope.
export async function resolveChat(
	db: Database,
	userId: string,
	scope: ChatScope,
	chatId: string | null,
	title: string
): Promise<string | null> {
	if (chatId) {
		const chat = await getChat(db, userId, chatId);
		return chat && sameScope(chat.scope, scope) ? chat.id : null;
	}
	const [row] = await db
		.insert(assistantChats)
		.values({ ...scopeValues(scope), userId, title })
		.returning({ id: assistantChats.id });
	return row.id;
}

// A new chat under an id the panel picked, so the panel knows the id even if
// the request is stopped before the reply starts. Sending under the same id
// again reaches the same chat (created false); an id that is someone else's
// chat, or this writer's chat in another scope, is null.
export async function openNewChat(
	db: Database,
	userId: string,
	scope: ChatScope,
	newId: string,
	title: string
): Promise<{ id: string; created: boolean; title: string } | null> {
	const [row] = await db
		.insert(assistantChats)
		.values({ id: newId, ...scopeValues(scope), userId, title })
		.onConflictDoNothing()
		.returning({ id: assistantChats.id });
	if (row) return { id: row.id, created: true, title };
	const chat = await getChat(db, userId, newId);
	return chat && sameScope(chat.scope, scope)
		? { id: chat.id, created: false, title: chat.title }
		: null;
}

// The chat the panel opens with: the most recently used one, if any.
export async function loadAssistantChat(
	db: Database,
	userId: string,
	scope: ChatScope
): Promise<{
	chats: ChatSummary[];
	chatId: string | null;
	messages: StoredChatMessage[];
	summarised: boolean;
	settings: ChatModelSettings;
	model: ChatModelInfo;
}> {
	const [chats, model] = await Promise.all([
		listChats(db, userId, scope),
		// The chip is a convenience: a config that cannot be read (a key that no
		// longer decrypts) must not take the page down with it.
		resolveLlmConfig(db, userId, scope).then(
			(resolved) => chatModelInfo(resolved.config),
			(): ChatModelInfo => ({ model: '', effort: null, claude: false })
		)
	]);
	const current = chats[0];
	if (!current)
		return { chats, chatId: null, messages: [], summarised: false, settings: {}, model };
	const [messages, [summary], chat] = await Promise.all([
		listChat(db, userId, current.id),
		db
			.select({ id: assistantChatSummaries.id })
			.from(assistantChatSummaries)
			.where(eq(assistantChatSummaries.chatId, current.id)),
		getChat(db, userId, current.id)
	]);
	return {
		chats,
		chatId: current.id,
		messages,
		summarised: Boolean(summary),
		settings: chat?.settings ?? {},
		model
	};
}

export async function listChat(
	db: Database,
	userId: string,
	chatId: string
): Promise<StoredChatMessage[]> {
	const rows = await db
		.select({
			role: assistantChatMessages.role,
			content: assistantChatMessages.content,
			meta: assistantChatMessages.meta
		})
		.from(assistantChatMessages)
		.where(and(eq(assistantChatMessages.userId, userId), eq(assistantChatMessages.chatId, chatId)))
		.orderBy(asc(assistantChatMessages.createdAt), asc(assistantChatMessages.id));
	return rows;
}

export async function appendChat(
	db: Database,
	userId: string,
	scope: ChatScope,
	chatId: string,
	message: StoredChatMessage
): Promise<boolean> {
	if (!message.content.trim() && !message.meta) return true;
	try {
		await db.insert(assistantChatMessages).values({
			...scopeValues(scope),
			chatId,
			userId,
			role: message.role,
			content: message.content,
			meta: message.meta
		});
	} catch (err) {
		// The chat was deleted (in another tab) since the request named it.
		if (isForeignKeyViolation(err)) return false;
		throw err;
	}
	// Trim the scrollback to the newest MAX_TURNS rows. Rows can share a
	// created_at, so the cut is by row (id breaks ties), not by timestamp.
	const keep = db
		.select({ id: assistantChatMessages.id })
		.from(assistantChatMessages)
		.where(eq(assistantChatMessages.chatId, chatId))
		.orderBy(desc(assistantChatMessages.createdAt), desc(assistantChatMessages.id))
		.limit(MAX_TURNS);
	await db
		.delete(assistantChatMessages)
		.where(
			and(eq(assistantChatMessages.chatId, chatId), notInArray(assistantChatMessages.id, keep))
		);
	// The picker lists chats by when they were last used.
	await db
		.update(assistantChats)
		.set({ updatedAt: sql`clock_timestamp()` })
		.where(eq(assistantChats.id, chatId));
	return true;
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

// MAX_TURNS above bounds storage; the budget (chatBudgetTokens in
// context/budgets.ts) bounds what the model is sent, so a long conversation
// cannot crowd out the assembled world or overflow a small context window.
// Greedily keep turns newest-first until the budget is spent, then restore
// order; the oldest turns drop, like a scrollback that scrolls off the top.
// The newest turn is always kept even if it alone exceeds the budget, so a
// request never arrives empty. Pure, so the drop policy is testable without a
// database.
export function fitChatTurns(
	turns: ChatMessage[],
	budgetTokens = CHAT_BUDGET_TOKENS
): ChatMessage[] {
	const kept: ChatMessage[] = [];
	let used = 0;
	for (let i = turns.length - 1; i >= 0; i--) {
		const cost = estimateTokens(turns[i].content);
		if (used > 0 && used + cost > budgetTokens) break;
		kept.push(turns[i]);
		used += cost;
	}
	kept.reverse();
	// Dropping the oldest turns can leave the transcript starting on an assistant
	// reply, which the Anthropic API rejects outright; the reply also reads as
	// an answer to a question no longer there. Both go with it.
	while (kept.length > 1 && kept[0].role === 'assistant') kept.shift();
	return kept;
}

// A reply that was stopped or failed is not stored, so the transcript can hold
// two user turns in a row. Some OpenAI-compatible servers refuse turns that do
// not alternate, so back-to-back turns of one role go out as one.
export function mergeAdjacentTurns(turns: ChatMessage[]): ChatMessage[] {
	const merged: ChatMessage[] = [];
	for (const turn of turns) {
		const last = merged[merged.length - 1];
		if (last && last.role === turn.role && (turn.role === 'user' || turn.role === 'assistant')) {
			merged[merged.length - 1] = { ...last, content: `${last.content}\n\n${turn.content}` };
		} else merged.push(turn);
	}
	return merged;
}

export function isForeignKeyViolation(err: unknown): boolean {
	for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
		if (e.code === '23503') return true;
	}
	return false;
}

// A chat the request created that ended with no turns stored (a recap that
// failed or was stopped) is dropped, so it does not sit empty in the list.
export async function dropChatIfEmpty(db: Database, chatId: string): Promise<void> {
	const [turn] = await db
		.select({ id: assistantChatMessages.id })
		.from(assistantChatMessages)
		.where(eq(assistantChatMessages.chatId, chatId))
		.limit(1);
	if (!turn) await db.delete(assistantChats).where(eq(assistantChats.id, chatId));
}

// Deletes one of the writer's chats with its turns and summary. Returns false
// when the chat is not theirs.
export async function deleteChat(db: Database, userId: string, chatId: string): Promise<boolean> {
	if (!(await getChat(db, userId, chatId))) return false;
	await db.transaction(async (tx) => {
		// Locking the chat row first makes a turn being stored at the same moment
		// wait, then find the chat gone, instead of landing between the deletes.
		await tx
			.select({ id: assistantChats.id })
			.from(assistantChats)
			.where(eq(assistantChats.id, chatId))
			.for('update');
		await tx.delete(assistantChatMessages).where(eq(assistantChatMessages.chatId, chatId));
		await tx.delete(assistantChatSummaries).where(eq(assistantChatSummaries.chatId, chatId));
		await tx.delete(assistantChats).where(eq(assistantChats.id, chatId));
	});
	return true;
}
