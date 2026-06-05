import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { bucketAssetLoader, gatherStory } from '$lib/server/export';
import { buildEpub } from '$lib/server/epub';

// Downloads the story as an EPUB.
export const GET: RequestHandler = async ({ params, locals }) => {
	const { story } = await ownedStory(params.id, locals.user!.id);
	const content = await gatherStory(db, story);
	const { filename, bytes } = await buildEpub(
		story,
		content,
		bucketAssetLoader(db),
		story.coverAssetId
	);
	return new Response(new Uint8Array(bytes), {
		headers: {
			'content-type': 'application/epub+zip',
			'content-disposition': `attachment; filename="${filename}"`
		}
	});
};
