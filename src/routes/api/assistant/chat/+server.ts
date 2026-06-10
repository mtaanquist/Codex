import { error, json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { rateLimitAssistant } from '$lib/server/write-guard';
import { assistantLayout } from '$lib/server/llm/config';
import { assembleContext, buildSystemMessage } from '$lib/server/llm/context/assemble';
import { AssistantDisabledError, stream } from '$lib/server/llm/gateway';
import { appendChat, clearChat } from '$lib/server/llm/chat-history';
import {
	foldReference,
	readReference,
	type ChatReference
} from '$lib/server/llm/prompts/reference';
import type { ChatMessage, SplitProposal, StreamEvent } from '$lib/server/llm/providers/types';

// The chat surface: the browser POSTs its transcript and the open scene, the
// server assembles the in-scope world, runs the gateway, and streams tokens
// back as Server-Sent Events. The key and endpoint never leave the server.
// The conversation persists per story and user: the newest user turn is
// stored when the request is accepted, the reply when its stream completes.
//
// Tools are offered (grounding reads, suggest_edit/leave_comment writes); the
// gateway withholds them when the endpoint cannot call them. A muted story
// disables this even though its tab stays visible to un-mute, so the gate is
// re-checked here.

type Turn = { role: 'user' | 'assistant'; content: string; reference: ChatReference | null };

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
			const reference =
				role === 'user' ? readReference((item as { reference?: unknown }).reference) : null;
			turns.push({ role, content, reference });
		}
	}
	if (turns.length === 0) error(400, 'Send at least one message.');
	if (turns.length > 100) error(400, 'Conversation is too long.');
	return turns;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);

	const payload = (await request.json().catch(() => null)) as {
		storyId?: unknown;
		sceneId?: unknown;
		messages?: unknown;
	} | null;
	if (!payload) error(400, 'Expected a JSON body.');

	const storyId = typeof payload.storyId === 'string' ? payload.storyId : '';
	if (!storyId) error(400, 'storyId is required.');
	const sceneId = typeof payload.sceneId === 'string' ? payload.sceneId : undefined;
	const turns = readTurns(payload.messages);

	// 404s unless the user owns the story; the chat is owner-scoped.
	const { story } = await ownedStory(storyId, userId);

	// Re-check the gate server-side: the tab shows on a muted story to un-mute,
	// but generation must not run there.
	const layout = await assistantLayout(db, userId, story.id);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this story.');

	// The newest user turn joins the stored transcript; the earlier turns are
	// already there from their own requests.
	const newest = turns[turns.length - 1];
	if (newest.role === 'user') {
		await appendChat(db, userId, story.id, {
			role: 'user',
			content: newest.content,
			meta: newest.reference ? { reference: newest.reference } : null
		});
	}

	// The assembled world rides as a system message after the gateway's persona
	// message; null when the story is empty or not owned (already checked).
	const context = await assembleContext(db, { userId, storyId: story.id, sceneId });
	const modelTurns: ChatMessage[] = turns.map((turn) => ({
		role: turn.role,
		content: turn.reference ? foldReference(turn.content, turn.reference) : turn.content
	}));
	const messages: ChatMessage[] = context
		? [buildSystemMessage(context, { tools: true }), ...modelTurns]
		: modelTurns;

	const encoder = new TextEncoder();
	const frame = (event: StreamEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			// The reply accumulates here and persists only when the stream ends
			// cleanly; an aborted or failed turn stores nothing.
			let reply = '';
			const proposals: SplitProposal[] = [];
			try {
				for await (const event of stream(db, {
					userId,
					storyId: story.id,
					role: 'chat',
					enableTools: true,
					messages,
					signal: request.signal
				})) {
					controller.enqueue(frame(event));
					if (event.type === 'token') reply += event.text;
					else if (event.type === 'proposal') proposals.push(event.proposal);
					if (event.type === 'done') {
						if (reply.trim() || proposals.length > 0) {
							await appendChat(db, userId, story.id, {
								role: 'assistant',
								content: reply,
								meta: proposals.length > 0 ? { proposals } : null
							});
						}
						break;
					}
					if (event.type === 'error') break;
				}
			} catch (err) {
				// A client disconnect aborts the upstream fetch; nothing more to send.
				if (!request.signal.aborted) {
					const message =
						err instanceof AssistantDisabledError
							? err.message
							: 'The Assistant could not complete that request.';
					try {
						controller.enqueue(frame({ type: 'error', message }));
					} catch {
						// controller already closed
					}
				}
			} finally {
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
			connection: 'keep-alive'
		}
	});
};

// Clear conversation: drops the stored transcript for this story. Deletes
// only, so it needs ownership but no Assistant gate.
export const DELETE: RequestHandler = async ({ request, locals }) => {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);
	const payload = (await request.json().catch(() => null)) as { storyId?: unknown } | null;
	const storyId = payload && typeof payload.storyId === 'string' ? payload.storyId : '';
	if (!storyId) error(400, 'storyId is required.');
	const { story } = await ownedStory(storyId, userId);
	await clearChat(db, userId, story.id);
	return json({ ok: true });
};
