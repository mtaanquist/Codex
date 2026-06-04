import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { bucketAssetLoader, buildStoryZip } from '$lib/server/export';

// Downloads the story as a zip of markdown files with bundled images.
export const GET: RequestHandler = async ({ params, locals }) => {
	const { story } = await ownedStory(params.id, locals.user!.id);
	const { filename, bytes } = await buildStoryZip(db, story, bucketAssetLoader(db));
	return new Response(new Uint8Array(bytes), {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="${filename}"`
		}
	});
};
