import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { assistantLayout, pickModel, resolveLlmConfig } from '#lib/server/llm/config';
import { searchContext, storyContents } from '#lib/server/llm/attachments';
import { rateLimitAssistant } from '#lib/server/write-guard';
import { isUuid } from '#lib/slug';

// The composer's "Add context" picker. ?q= searches the writer's library (with
// no query it lists the stories); ?storyId= lists one story's chapters and
// scenes and the size of the whole book, priced on the chat's model (?model=,
// else the default) where the endpoint reported a price.
export const GET: RequestHandler = async ({ url, locals }) => {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);
	const layout = await assistantLayout(db, userId);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this account.');

	const storyId = url.searchParams.get('storyId');
	if (storyId !== null) {
		if (!isUuid(storyId)) error(404, 'No such story.');
		const contents = await storyContents(db, userId, storyId);
		if (!contents) error(404, 'No such story.');
		const { config } = await resolveLlmConfig(db, userId);
		const model = url.searchParams.get('model') || pickModel(config, 'chat');
		const price = config.modelPricing?.[model]?.prompt;
		return Response.json({
			...contents,
			usd: price === undefined ? null : contents.tokens * price
		});
	}
	const query = (url.searchParams.get('q') ?? '').slice(0, 200);
	return Response.json({ items: await searchContext(db, userId, query) });
};
