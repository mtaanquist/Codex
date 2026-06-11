import { isUuid } from '$lib/slug';
// A chat turn can point at a passage of the open story ("Ask the Assistant
// about this" on a selection). The client sends the reference as data beside
// the message so the transcript can render it as a chip; here it is folded
// into the content the model sees, so the framing stays server-controlled.

export type ChatReference = { sceneId: string; text: string };

export const MAX_REFERENCE_CHARS = 2000;

// Validates a raw reference from the client; null when it is not usable.
// Oversized selections are truncated rather than rejected - the writer's
// question should not bounce because they selected a page.
export function readReference(raw: unknown): ChatReference | null {
	if (!raw || typeof raw !== 'object') return null;
	const sceneId = (raw as { sceneId?: unknown }).sceneId;
	const text = (raw as { text?: unknown }).text;
	if (typeof sceneId !== 'string' || !isUuid(sceneId)) return null;
	if (typeof text !== 'string' || !text.trim()) return null;
	return { sceneId, text: text.trim().slice(0, MAX_REFERENCE_CHARS) };
}

// Folds the referenced passage into the user's message as a quoted block.
export function foldReference(content: string, reference: ChatReference): string {
	const quoted = reference.text
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n');
	return [
		`The writer is pointing at this passage (in scene id ${reference.sceneId}):`,
		'',
		quoted,
		'',
		content
	].join('\n');
}
