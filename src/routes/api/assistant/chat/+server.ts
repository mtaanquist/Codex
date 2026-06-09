import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { rateLimitAssistant } from '$lib/server/write-guard';
import { assistantLayout } from '$lib/server/llm/config';
import { assembleContext, buildSystemMessage } from '$lib/server/llm/context/assemble';
import { AssistantDisabledError, stream } from '$lib/server/llm/gateway';
import type { ChatMessage, StreamEvent } from '$lib/server/llm/providers/types';

// The chat surface: the browser POSTs its transcript and the open scene, the
// server assembles the in-scope world, runs the gateway, and streams tokens
// back as Server-Sent Events. The key and endpoint never leave the server.
//
// Tools are offered (grounding reads, suggest_edit/leave_comment writes); the
// gateway withholds them when the endpoint cannot call them. A muted story
// disables this even though its tab stays visible to un-mute, so the gate is
// re-checked here.

// Only the writer's own user/assistant turns are accepted; system and tool
// messages are the server's to add, never the client's.
function readTurns(raw: unknown): ChatMessage[] {
	if (!Array.isArray(raw)) error(400, 'messages must be an array.');
	const turns: ChatMessage[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const role = (item as { role?: unknown }).role;
		const content = (item as { content?: unknown }).content;
		if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
			turns.push({ role, content });
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

	// The assembled world rides as a system message after the gateway's persona
	// message; null when the story is empty or not owned (already checked).
	const context = await assembleContext(db, { userId, storyId: story.id, sceneId });
	const messages: ChatMessage[] = context ? [buildSystemMessage(context), ...turns] : turns;

	const encoder = new TextEncoder();
	const frame = (event: StreamEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
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
					if (event.type === 'done' || event.type === 'error') break;
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
