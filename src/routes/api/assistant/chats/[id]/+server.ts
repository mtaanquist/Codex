import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { deleteChat, getChat, listChat } from '#lib/server/llm/chat-history';
import { hasChatSummary } from '#lib/server/llm/chat-summary';

// One of the writer's Assistant chats: GET loads its turns when the panel
// switches to it, DELETE removes it. Reading and deleting stored turns need no
// Assistant gate, only that the chat is the writer's own.

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Sign in first.');
	const chat = await getChat(db, locals.user.id, params.id!);
	if (!chat) error(404, 'That chat does not exist.');
	const [messages, summarised] = await Promise.all([
		listChat(db, locals.user.id, chat.id),
		hasChatSummary(db, locals.user.id, chat.id)
	]);
	return Response.json({ messages, summarised });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Sign in first.');
	if (!(await deleteChat(db, locals.user.id, params.id!))) error(404, 'That chat does not exist.');
	return Response.json({ ok: true });
};
