import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { buildUniverseExport, bucketAssetLoader } from '$lib/server/export';
import { ownedUniverse } from '$lib/server/universe-access';

// Downloads one universe as a markdown archive: characters/, places/,
// lore/, and a folder per story, with images bundled.
export const GET: RequestHandler = async ({ params, locals }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	const { filename, bytes } = await buildUniverseExport(
		db,
		universe,
		bucketAssetLoader(db, locals.user!.id)
	);
	return new Response(new Uint8Array(bytes), {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="${filename}"`
		}
	});
};
