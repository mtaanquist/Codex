import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { rateLimitAssistant } from '$lib/server/write-guard';
import { assistantLayout } from '$lib/server/llm/config';
import { buildContinuationMessage } from '$lib/server/llm/prompts/continuation';
import { AssistantDisabledError, complete } from '$lib/server/llm/gateway';

// Inline continuation: the editor sends the prose before the cursor and gets a
// short continuation back, shown as ghost-text the writer accepts with Tab.
// Buffered (not streamed) and tool-free in the first cut, for a quick turnaround.
// The result is a suggestion, never a silent write - the editor inserts it only
// when the writer accepts.

const MAX_CONTINUATION_TOKENS = 400;

export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);

	const payload = (await request.json().catch(() => null)) as {
		storyId?: unknown;
		textBefore?: unknown;
		maxTokens?: unknown;
	} | null;
	const storyId = payload && typeof payload.storyId === 'string' ? payload.storyId : '';
	const textBefore = payload && typeof payload.textBefore === 'string' ? payload.textBefore : '';
	if (!storyId) error(400, 'storyId is required.');
	if (!textBefore.trim()) error(400, 'Nothing to continue from.');
	const maxTokens =
		payload && typeof payload.maxTokens === 'number' && payload.maxTokens > 0
			? Math.min(Math.floor(payload.maxTokens), MAX_CONTINUATION_TOKENS)
			: 220;

	// 404s unless the user owns the story.
	const { story } = await ownedStory(storyId, userId);

	const layout = await assistantLayout(db, userId, story.id);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this story.');

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
		if (err instanceof AssistantDisabledError) error(403, err.message);
		error(502, 'The Assistant could not continue the passage.');
	}

	return new Response(JSON.stringify({ text: text.trim() }), {
		headers: { 'content-type': 'application/json' }
	});
};
