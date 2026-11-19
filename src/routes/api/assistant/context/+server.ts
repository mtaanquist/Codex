import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import {
	assistantLayout,
	modelContextWindow,
	pickModel,
	resolveLlmConfig,
	withRoleOverride
} from '#lib/server/llm/config';
import { attachmentBudgetTokens } from '#lib/server/llm/context/budgets';
import { searchContext, storyContents } from '#lib/server/llm/attachments';
import { rateLimitLookups } from '#lib/server/write-guard';
import { isUuid } from '#lib/slug';

// The composer's "Add context" picker. ?q= searches the writer's library (with
// no query it lists the stories); ?storyId= lists one story's chapters and
// scenes and the size of the whole book, priced on the chat's model (?model=,
// else the default) where the endpoint reported a price.
export const GET: RequestHandler = async ({ url, locals }) => {
	const userId = locals.user!.id;
	rateLimitLookups(userId);
	const layout = await assistantLayout(db, userId);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this account.');

	const storyId = url.searchParams.get('storyId');
	if (storyId !== null) {
		if (!isUuid(storyId)) error(404, 'No such story.');
		const contents = await storyContents(db, userId, storyId);
		if (!contents) error(404, 'No such story.');
		// A config that cannot be read (a key that no longer decrypts) still
		// lists the story, just without a price.
		const config = await resolveLlmConfig(db, userId)
			.then((resolved) => resolved.config)
			.catch(() => null);
		const model = url.searchParams.get('model') || (config ? pickModel(config, 'chat') : '');
		const price = config?.modelPricing?.[model]?.prompt;
		// Priced on what is sent: a book over the attachment budget is cut.
		const window = config
			? modelContextWindow(withRoleOverride(config, 'chat', { model }), 'chat')
			: undefined;
		const sent = Math.min(contents.tokens, attachmentBudgetTokens(window));
		return Response.json({
			...contents,
			cut: sent < contents.tokens,
			usd: price === undefined ? null : sent * price
		});
	}
	const query = (url.searchParams.get('q') ?? '').slice(0, 200);
	return Response.json({ items: await searchContext(db, userId, query) });
};
