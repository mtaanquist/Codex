import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { deleteChat, getChat, listChat } from '#lib/server/llm/chat-history';
import { hasChatSummary } from '#lib/server/llm/chat-summary';
import { CHAT_MISSING } from '#lib/assistant-chat';
import { ownedStory } from '#lib/server/story-access';
import { ownedUniverse } from '#lib/server/universe-access';

// One of the writer's Assistant chats: GET loads its turns when the panel
// switches to it, DELETE removes it. Reading and deleting stored turns need no
// Assistant gate, only that the chat is the writer's own and its story or
// universe is not in the trash, like every other Assistant route.

async function liveChat(userId: string, id: string) {
	const chat = await getChat(db, userId, id);
	if (!chat) error(404, CHAT_MISSING);
	if ('storyId' in chat.scope) await ownedStory(chat.scope.storyId, userId);
	else await ownedUniverse(chat.scope.universeId, userId);
	return chat;
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Sign in first.');
	const chat = await liveChat(locals.user.id, params.id!);
	const [messages, summarised] = await Promise.all([
		listChat(db, locals.user.id, chat.id),
		hasChatSummary(db, locals.user.id, chat.id)
	]);
	return Response.json({ messages, summarised, settings: chat.settings });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Sign in first.');
	const chat = await liveChat(locals.user.id, params.id!);
	if (!(await deleteChat(db, locals.user.id, chat.id))) error(404, CHAT_MISSING);
	return Response.json({ ok: true });
};
