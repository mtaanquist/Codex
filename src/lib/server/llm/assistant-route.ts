import { error } from '@sveltejs/kit';
import { db } from '../db';
import { ownedStory } from '../story-access';
import { ownedUniverse } from '../universe-access';
import { rateLimitAssistant } from '../write-guard';
import { readJson } from '../validation';
import { assistantLayout } from './config';
import { AssistantDisabledError, ReplyCutOffError, stream } from './gateway';
import {
	appendChat,
	dropChatIfEmpty,
	openNewChat,
	resolveChat,
	type ChatScope
} from './chat-history';
import { CHAT_MISSING, type ChatModelSettings } from '#lib/assistant-chat';
import { isUuid } from '#lib/slug';
import {
	writerStopSignal,
	type ChatMessage,
	type SplitProposal,
	type StreamEvent
} from './providers/types';

// The shared front door and transport of the assistant endpoints, so the
// rate-limit/parse/ownership/gate sequence and the SSE pump exist once
// instead of once per route.

// The signal an Assistant request runs under. The browser going away is the
// writer stopping it, which nothing retries (see WriterStopError).
export function requestSignal(request: Request): AbortSignal {
	return writerStopSignal(request.signal);
}

// Rate-limits the caller and parses the JSON body.
export async function readAssistantPayload<T = Record<string, unknown>>(
	request: Request,
	locals: { user: { id: string } | null }
): Promise<{ userId: string; payload: T }> {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);
	const payload = await readJson<T>(request);
	return { userId, payload };
}

// 403s when the Assistant is off for the story: the tab stays visible on a
// muted story to un-mute it, but generation must not run there, so every
// endpoint re-checks the gate server-side. Returns the layout for callers
// that need the Assistant's display name.
export async function requireAssistantGate(userId: string, storyId: string) {
	const layout = await assistantLayout(db, userId, storyId);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this story.');
	return layout;
}

// The common shape: storyId in the payload, 404 unless the user owns the
// story, then the gate. Returns the story for the route body.
export async function requireAssistantStory(userId: string, storyId: unknown) {
	const ref = typeof storyId === 'string' ? storyId : '';
	if (!ref) error(400, 'storyId is required.');
	const { story } = await ownedStory(ref, userId);
	await requireAssistantGate(userId, story.id);
	return story;
}

// The universe-surface counterpart: universeId in the payload, 404 unless the
// user owns the universe, then the account-level gate (there is no per-universe
// mute, so the gate is the account master). Returns the universe.
export async function requireAssistantUniverse(userId: string, universeId: unknown) {
	const ref = typeof universeId === 'string' ? universeId : '';
	if (!ref) error(400, 'universeId is required.');
	const universe = await ownedUniverse(ref, userId);
	const layout = await assistantLayout(db, userId);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this account.');
	return universe;
}

// The 403/502 split every synchronous assistant endpoint makes.
export function throwAssistantError(err: unknown, fallback: string): never {
	if (err instanceof AssistantDisabledError) error(403, err.message);
	if (err instanceof ReplyCutOffError) error(502, err.message);
	error(502, fallback);
}

// The chat a turn belongs to: the writer's chat named by payload.chatId in this
// scope, or a new one titled `title` when the payload names none (created says
// which). A new chat takes the id the panel picked (newChatId) when it sent
// one. A chatId that is not the writer's chat in this scope is a 404, so ids
// cannot be probed.
export async function requireChat(
	userId: string,
	scope: ChatScope,
	rawChatId: unknown,
	title: string,
	rawNewChatId?: unknown
): Promise<{ id: string; created: boolean; title?: string }> {
	if (rawChatId !== undefined && rawChatId !== null && typeof rawChatId !== 'string') {
		error(400, 'chatId must be a string.');
	}
	const named = rawChatId || null;
	if (!named && rawNewChatId !== undefined && rawNewChatId !== null) {
		if (typeof rawNewChatId !== 'string' || !isUuid(rawNewChatId)) {
			error(400, 'newChatId must be a uuid.');
		}
		const opened = await openNewChat(db, userId, scope, rawNewChatId, title);
		if (!opened) error(404, CHAT_MISSING);
		return opened;
	}
	const chatId = await resolveChat(db, userId, scope, named, title);
	if (!chatId) error(404, CHAT_MISSING);
	return { id: chatId, created: !named, ...(named ? {} : { title }) };
}

// Streams a gateway turn back as Server-Sent Events. The reply accumulates
// and persists to the stored conversation only when the stream ends cleanly,
// before the done frame is sent; an aborted or failed turn stores nothing. Proposals (split cards) and a
// cut-short note ride the stream and persist with the reply.
export function assistantSseResponse(options: {
	request: Request;
	userId: string;
	// The conversation this turn belongs to: a story (Write/Review/story-Plan)
	// or a universe (universe-Plan). Drives both the gateway's tool reach and
	// where the reply is persisted.
	scope: ChatScope;
	// The chat the reply is stored in; sent back as x-chat-id so a panel that
	// started a new chat learns its id. A chat this request created is dropped
	// again if the stream stores nothing in it.
	chat: { id: string; created: boolean; title?: string };
	// Conversational turns run as 'chat'; the recap runs as 'utility'. Both land
	// in the same stored conversation.
	role: 'chat' | 'utility';
	// The chat's own model and effort (the composer's model chip).
	override?: ChatModelSettings;
	enableTools: boolean;
	messages: ChatMessage[];
	// Older turns of this conversation were summarised; the panel shows a note.
	summarised?: boolean;
	// The newest message's attachments as sent, when it had any: their keys,
	// with a trailing "!" on each one cut to fit. Ones left out (gone, trashed,
	// muted) are missing, so the panel's chips can match what was stored.
	attached?: string[];
	errorMessage: string;
}): Response {
	const { request, userId, scope } = options;
	const chatId = options.chat.id;
	const storyId = 'storyId' in scope ? scope.storyId : undefined;
	const universeId = 'universeId' in scope ? scope.universeId : undefined;
	const encoder = new TextEncoder();
	const frame = (event: StreamEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let reply = '';
			const proposals: SplitProposal[] = [];
			let stopped: 'context' | 'budget' | undefined;
			try {
				for await (const event of stream(db, {
					userId,
					storyId,
					universeId,
					role: options.role,
					override: options.override,
					enableTools: options.enableTools,
					messages: options.messages,
					signal: requestSignal(request)
				})) {
					// done goes out only once the reply is stored, so a panel that
					// reads it can count the reply as part of the chat.
					if (event.type !== 'done') controller.enqueue(frame(event));
					if (event.type === 'token') reply += event.text;
					else if (event.type === 'proposal') proposals.push(event.proposal);
					else if (event.type === 'stopped') stopped = event.reason;
					if (event.type === 'done') {
						// A reply cut short with no text is kept, empty, for its note;
						// the panel shows a line in its place.
						if (reply.trim() || proposals.length > 0 || stopped) {
							const meta = {
								...(proposals.length > 0 ? { proposals } : {}),
								...(stopped ? { stopped } : {})
							};
							// False when the chat was deleted mid-reply; the reply goes with it.
							await appendChat(db, userId, scope, chatId, {
								role: 'assistant',
								content: reply,
								meta: Object.keys(meta).length > 0 ? meta : null
							});
						}
						controller.enqueue(frame(event));
						break;
					}
					if (event.type === 'error') break;
				}
			} catch (err) {
				// A client disconnect aborts the upstream fetch; nothing more to send.
				if (!request.signal.aborted) {
					const message =
						err instanceof AssistantDisabledError ? err.message : options.errorMessage;
					try {
						controller.enqueue(frame({ type: 'error', message }));
					} catch {
						// controller already closed
					}
				}
			} finally {
				if (options.chat.created) {
					await dropChatIfEmpty(db, chatId).catch(() => {});
				}
				try {
					controller.close();
				} catch {
					// already closed by a client disconnect
				}
			}
		}
	});

	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-chat-id': chatId,
			// A chat the panel had not opened yet: its stored title, and whether
			// this request made it (else an earlier, stopped send did).
			...(options.chat.title !== undefined
				? {
						'x-chat-title': encodeURIComponent(options.chat.title),
						'x-chat-created': options.chat.created ? '1' : '0'
					}
				: {}),
			...(options.summarised ? { 'x-chat-summarised': '1' } : {}),
			...(options.attached ? { 'x-chat-attachments': options.attached.join(',') } : {})
		}
	});
}
