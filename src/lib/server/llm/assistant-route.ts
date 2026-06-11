import { error } from '@sveltejs/kit';
import { db } from '../db';
import { ownedStory } from '../story-access';
import { rateLimitAssistant } from '../write-guard';
import { readJson } from '../validation';
import { assistantLayout } from './config';
import { AssistantDisabledError, stream } from './gateway';
import { appendChat } from './chat-history';
import type { ChatMessage, SplitProposal, StreamEvent } from './providers/types';

// The shared front door and transport of the assistant endpoints, so the
// rate-limit/parse/ownership/gate sequence and the SSE pump exist once
// instead of once per route.

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

// The 403/502 split every synchronous assistant endpoint makes.
export function throwAssistantError(err: unknown, fallback: string): never {
	if (err instanceof AssistantDisabledError) error(403, err.message);
	error(502, fallback);
}

// Streams a gateway turn back as Server-Sent Events. The reply accumulates
// and persists to the stored conversation only when the stream ends cleanly;
// an aborted or failed turn stores nothing. Proposals (split cards) ride the
// stream and persist with the reply when tools are enabled.
export function assistantSseResponse(options: {
	request: Request;
	userId: string;
	storyId: string;
	role: 'chat';
	enableTools: boolean;
	messages: ChatMessage[];
	errorMessage: string;
}): Response {
	const { request, userId, storyId } = options;
	const encoder = new TextEncoder();
	const frame = (event: StreamEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let reply = '';
			const proposals: SplitProposal[] = [];
			try {
				for await (const event of stream(db, {
					userId,
					storyId,
					role: options.role,
					enableTools: options.enableTools,
					messages: options.messages,
					signal: request.signal
				})) {
					controller.enqueue(frame(event));
					if (event.type === 'token') reply += event.text;
					else if (event.type === 'proposal') proposals.push(event.proposal);
					if (event.type === 'done') {
						if (reply.trim() || proposals.length > 0) {
							await appendChat(db, userId, storyId, {
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
						err instanceof AssistantDisabledError ? err.message : options.errorMessage;
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
}
