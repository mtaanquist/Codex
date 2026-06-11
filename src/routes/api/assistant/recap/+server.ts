import { error, type RequestHandler } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { scenes } from '$lib/server/db/schema';
import { ownedStory } from '$lib/server/story-access';
import { rateLimitAssistant } from '$lib/server/write-guard';
import { assistantLayout } from '$lib/server/llm/config';
import { assembleRecapContext } from '$lib/server/llm/context/assemble';
import { buildRecapMessage } from '$lib/server/llm/prompts/recap';
import { AssistantDisabledError, stream } from '$lib/server/llm/gateway';
import { appendChat } from '$lib/server/llm/chat-history';
import type { ChatMessage, StreamEvent } from '$lib/server/llm/providers/types';

// Recap ("catch me up"): the server assembles the story so far - every scene up
// to and including the open one - and streams a recap back as Server-Sent
// Events, the same transport as chat. It summarises existing prose and runs no
// tools. The key and endpoint never leave the server.

export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);

	const payload = (await request.json().catch(() => null)) as {
		storyId?: unknown;
		sceneId?: unknown;
	} | null;
	const storyId = payload && typeof payload.storyId === 'string' ? payload.storyId : '';
	const sceneId = payload && typeof payload.sceneId === 'string' ? payload.sceneId : undefined;
	if (!storyId) error(400, 'storyId is required.');

	// 404s unless the user owns the story; the recap is owner-scoped.
	const { story } = await ownedStory(storyId, userId);

	// Re-check the gate: the tab stays on a muted story to un-mute, but
	// generation must not run there.
	const layout = await assistantLayout(db, userId, story.id);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this story.');

	const context = await assembleRecapContext(db, { userId, storyId: story.id, sceneId });
	if (!context) error(404, 'No story to recap.');

	// The scene the recap runs through, for the instruction; owner already checked.
	let throughTitle: string | null = null;
	if (sceneId) {
		const [scene] = await db
			.select({ title: scenes.title })
			.from(scenes)
			.where(and(eq(scenes.id, sceneId), eq(scenes.storyId, story.id), isNull(scenes.deletedAt)));
		throughTitle = scene?.title ?? null;
	}

	const messages: ChatMessage[] = [
		{ role: 'system', content: context },
		{ role: 'user', content: buildRecapMessage(throughTitle) }
	];

	const encoder = new TextEncoder();
	const frame = (event: StreamEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			// The recap joins the stored conversation as an assistant turn once
			// its stream ends cleanly.
			let reply = '';
			try {
				for await (const event of stream(db, {
					userId,
					storyId: story.id,
					role: 'chat',
					enableTools: false,
					messages,
					signal: request.signal
				})) {
					controller.enqueue(frame(event));
					if (event.type === 'token') reply += event.text;
					if (event.type === 'done') {
						if (reply.trim()) {
							await appendChat(db, userId, story.id, {
								role: 'assistant',
								content: reply,
								meta: null
							});
						}
						break;
					}
					if (event.type === 'error') break;
				}
			} catch (err) {
				if (!request.signal.aborted) {
					const message =
						err instanceof AssistantDisabledError
							? err.message
							: 'The Assistant could not put together a recap.';
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
