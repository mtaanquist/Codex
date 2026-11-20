import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { assistantLayout, resolveLlmConfig } from '#lib/server/llm/config';
import { listEndpointModels } from '#lib/server/llm/models';
import { ownedStory } from '#lib/server/story-access';
import { rateLimitLookups } from '#lib/server/write-guard';

// The models the composer's model chip offers: what the account's endpoint
// lists, plus any model the writer has already set for a role, so an endpoint
// that cannot list its models still offers those. A failed listing is not an
// error; the chip shows what it has and says the list is incomplete. With
// ?storyId= (the story the panel is on) the models set for that story count.
export const GET: RequestHandler = async ({ url, locals }) => {
	const userId = locals.user!.id;
	rateLimitLookups(userId);
	const layout = await assistantLayout(db, userId);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this account.');
	// A config that cannot be read (a key that no longer decrypts) lists nothing.
	const storyRef = url.searchParams.get('storyId');
	const storyId = storyRef ? (await ownedStory(storyRef, userId)).story.id : undefined;
	const config = await resolveLlmConfig(db, userId, storyId)
		.then((resolved) => resolved.config)
		.catch(() => null);
	if (!config) return Response.json({ models: [], complete: false });
	const listed = await listEndpointModels(
		db,
		{ endpoint: config.endpoint, apiKey: config.apiKey },
		config.provider
	);
	const ids = new Set(listed.ok ? listed.models.map((model) => model.id) : []);
	for (const model of Object.values(config.models)) if (model) ids.add(model);
	return Response.json({
		models: [...ids].sort((a, b) => a.localeCompare(b)),
		complete: listed.ok
	});
};
