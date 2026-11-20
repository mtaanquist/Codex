import { error, isHttpError, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { errorFields, logEvent } from '#lib/server/log';
import {
	assistantSseResponse,
	readAssistantPayload,
	requestSignal,
	requireAssistantStory,
	requireAssistantUniverse,
	requireChat
} from '#lib/server/llm/assistant-route';
import {
	CHAT_MISSING,
	CHAT_STORED_HEADER,
	attachedHeader,
	chatTitle,
	readAttachments,
	readChatSettings,
	type ChatAttachment
} from '#lib/assistant-chat';
import { foldAttachments, noteAttachments, resolveAttachments } from '#lib/server/llm/attachments';
import {
	assembleContext,
	buildSystemMessage,
	type AssembleOptions
} from '#lib/server/llm/context/assemble';
import {
	appendChat,
	dropChatIfEmpty,
	getChat,
	mergeAdjacentTurns,
	setChatSettings,
	type ChatScope
} from '#lib/server/llm/chat-history';
import { fitChatWithSummary } from '#lib/server/llm/chat-summary';
import {
	attachmentBudgetTokens,
	chatBudgetTokens,
	contextBudgetTokens
} from '#lib/server/llm/context/budgets';
import { modelContextWindow, resolveLlmConfig, withRoleOverride } from '#lib/server/llm/config';
import {
	foldReference,
	readReference,
	type ChatReference
} from '#lib/server/llm/prompts/reference';
import type { ChatMessage } from '#lib/server/llm/providers/types';

// The chat surface: the browser POSTs its transcript and either the open story
// (and scene) or the universe in view, the server assembles the in-scope world,
// runs the gateway, and streams tokens back as Server-Sent Events. The key and
// endpoint never leave the server. Turns persist in the chat named by chatId,
// or a new chat when there is none (its id comes back as x-chat-id): the newest
// user turn is stored when the request is accepted, the reply when its stream
// completes.
//
// Tools are offered (grounding reads, suggest_edit/leave_comment writes); the
// gateway withholds them when the endpoint cannot call them. A muted story
// disables this even though its tab stays visible to un-mute, so the gate is
// re-checked here.

type Turn = {
	role: 'user' | 'assistant';
	content: string;
	reference: ChatReference | null;
	attachments: ChatAttachment[];
};

// A single turn's text; far beyond any real message, in line with the other
// surfaces' input caps.
const MAX_TURN_CHARS = 20_000;

// Only the writer's own user/assistant turns are accepted; system and tool
// messages are the server's to add, never the client's. A user turn may carry
// a reference to a passage of the open story, kept as data for the transcript
// chip and folded into the content the model sees.
function readTurns(raw: unknown): Turn[] {
	if (!Array.isArray(raw)) error(400, 'messages must be an array.');
	const turns: Turn[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const role = (item as { role?: unknown }).role;
		const content = (item as { content?: unknown }).content;
		if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
			if (content.length > MAX_TURN_CHARS) error(400, 'That message is too long.');
			const reference =
				role === 'user' ? readReference((item as { reference?: unknown }).reference) : null;
			const attachments =
				role === 'user' ? readAttachments((item as { attachments?: unknown }).attachments) : [];
			turns.push({ role, content, reference, attachments });
		}
	}
	if (turns.length === 0) error(400, 'Send at least one message.');
	if (turns.length > 100) error(400, 'Conversation is too long.');
	return turns;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		universeId?: unknown;
		sceneId?: unknown;
		chatId?: unknown;
		newChatId?: unknown;
		messages?: unknown;
		settings?: unknown;
	}>(request, locals);
	let settings = readChatSettings(payload.settings);
	const sceneId = typeof payload.sceneId === 'string' ? payload.sceneId : undefined;
	const turns = readTurns(payload.messages);

	// The scope: a story focus (Write/Review/story-Plan) or the whole universe
	// (universe-Plan). A storyId names the focus path; otherwise universeId.
	let scope: ChatScope;
	let assembleOptions: AssembleOptions;
	if (typeof payload.storyId === 'string' && payload.storyId) {
		const story = await requireAssistantStory(userId, payload.storyId);
		scope = { storyId: story.id };
		assembleOptions = { userId, storyId: story.id, sceneId };
	} else {
		const universe = await requireAssistantUniverse(userId, payload.universeId);
		scope = { universeId: universe.id };
		assembleOptions = { userId, universeId: universe.id };
	}

	// The newest user turn joins the stored transcript; the earlier turns are
	// already there from their own requests.
	const newest = turns[turns.length - 1];
	const chat = await requireChat(
		userId,
		scope,
		payload.chatId,
		chatTitle(newest.content),
		payload.newChatId
	);
	const chatId = chat.id;
	// A new chat is created before its first turn is stored; if a step in
	// between fails (a key that no longer decrypts, a failed read), it goes
	// again rather than sit empty in the chat list.
	let contextWindow: number | undefined;
	let attached: Awaited<ReturnType<typeof resolveAttachments>>;
	try {
		// Only a settings object is saved (an empty one clears the choice); a send
		// without one, or with anything else, runs on the stored choice.
		const raw = payload.settings;
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
			await setChatSettings(db, userId, chatId, settings);
		} else settings = (await getChat(db, userId, chatId))?.settings ?? {};

		// Every budget scales with the context window of the model this chat runs on.
		const resolved = await resolveLlmConfig(db, userId, scope);
		contextWindow = modelContextWindow(withRoleOverride(resolved.config, 'chat', settings), 'chat');

		// What the writer attached to the newest message, read by id and cut to
		// fit. The stored turn keeps which ones were cut, for its chips.
		attached =
			newest.role === 'user'
				? await resolveAttachments(
						db,
						userId,
						newest.attachments,
						attachmentBudgetTokens(contextWindow)
					)
				: [];
		if (newest.role === 'user') {
			const meta = {
				...(newest.reference ? { reference: newest.reference } : {}),
				...(attached.length > 0 ? { attachments: attached.map((item) => item.attachment) } : {})
			};
			const stored = await appendChat(db, userId, scope, chatId, {
				role: 'user',
				content: newest.content,
				meta: Object.keys(meta).length > 0 ? meta : null
			});
			if (!stored) error(404, CHAT_MISSING);
		}
	} catch (err) {
		if (chat.created) await dropChatIfEmpty(db, chatId).catch(() => {});
		if (isHttpError(err)) throw err;
		// An unexpected failure here is before the message was stored; say so,
		// so the panel puts it back in the chat box rather than count it sent.
		logEvent('error', 'request.error', {
			method: request.method,
			path: '/api/assistant/chat',
			status: 500,
			...errorFields(err)
		});
		return Response.json(
			{ message: 'Something went wrong before your message was stored. Try again in a moment.' },
			{ status: 500, headers: { [CHAT_STORED_HEADER]: '0' } }
		);
	}

	// The assembled world rides as a system message after the gateway's persona
	// message; null when the scope is empty or not owned (already checked).
	const context = await assembleContext(db, {
		...assembleOptions,
		budgetTokens: contextBudgetTokens(contextWindow)
	});
	// Folding a reference grows a turn, so the transcript is fitted to its budget
	// after the fold. Turns that fall out are summarised rather than dropped.
	// Request shaping only: the stored transcript and the panel's own scrollback
	// keep every turn.
	const fitted = await fitChatWithSummary(db, {
		userId,
		scope,
		chatId,
		turns: turns.map((turn, index) => {
			const content = turn.reference ? foldReference(turn.content, turn.reference) : turn.content;
			// Earlier attachments are named, not sent again.
			return {
				role: turn.role,
				content: index < turns.length - 1 ? noteAttachments(content, turn.attachments) : content
			};
		}),
		budgetTokens: chatBudgetTokens(contextWindow),
		signal: requestSignal(request)
	});
	// The attachments go into the newest turn after the transcript is fitted:
	// they have a budget of their own, and must not push earlier turns out.
	const last = fitted.messages[fitted.messages.length - 1];
	const fittedMessages =
		attached.length > 0 && last?.role === 'user'
			? [
					...fitted.messages.slice(0, -1),
					{ ...last, content: foldAttachments(last.content, attached) }
				]
			: fitted.messages;
	const messages: ChatMessage[] = context
		? [buildSystemMessage(context, { tools: true }), ...mergeAdjacentTurns(fittedMessages)]
		: mergeAdjacentTurns(fittedMessages);

	return assistantSseResponse({
		request,
		userId,
		scope,
		chat,
		role: 'chat',
		override: settings,
		enableTools: true,
		messages,
		summarised: fitted.summarised,
		attached:
			newest.role === 'user' && newest.attachments.length > 0
				? attachedHeader(
						attached.map((item) => item.attachment),
						newest.attachments
					)
				: undefined,
		errorMessage: 'The Assistant could not complete that request.'
	});
};
