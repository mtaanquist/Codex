import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	readAssistantPayload,
	requireAssistantStory,
	throwAssistantError
} from '$lib/server/llm/assistant-route';
import { buildContinuationMessage } from '$lib/server/llm/prompts/continuation';
import { complete } from '$lib/server/llm/gateway';

// Inline continuation: the editor sends the prose before the cursor and gets a
// short continuation back, shown as ghost-text the writer accepts with Tab.
// Buffered (not streamed) and tool-free in the first cut, for a quick turnaround.
// The result is a suggestion, never a silent write - the editor inserts it only
// when the writer accepts.

const MAX_CONTINUATION_TOKENS = 400;
// The prompt builder only uses the tail of the prose; refuse a pathological
// payload rather than carrying it through the request.
const MAX_TEXT_BEFORE_CHARS = 50_000;

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		textBefore?: unknown;
		maxTokens?: unknown;
	}>(request, locals);
	const rawText = typeof payload.textBefore === 'string' ? payload.textBefore : '';
	if (!rawText.trim()) error(400, 'Nothing to continue from.');
	const textBefore = rawText.slice(-MAX_TEXT_BEFORE_CHARS);
	const maxTokens =
		typeof payload.maxTokens === 'number' && payload.maxTokens > 0
			? Math.min(Math.floor(payload.maxTokens), MAX_CONTINUATION_TOKENS)
			: 220;
	const story = await requireAssistantStory(userId, payload.storyId);

	let text: string;
	try {
		text = await complete(db, {
			userId,
			storyId: story.id,
			role: 'continuation',
			enableTools: false,
			messages: [{ role: 'user', content: buildContinuationMessage(textBefore) }],
			maxTokens,
			signal: request.signal
		});
	} catch (err) {
		throwAssistantError(err, 'The Assistant could not continue the passage.');
	}

	return new Response(JSON.stringify({ text: text.trim() }), {
		headers: { 'content-type': 'application/json' }
	});
};
