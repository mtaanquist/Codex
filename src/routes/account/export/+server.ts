import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { buildAccountExport, bucketAssetLoader } from '$lib/server/export';
import { reviewLoader } from '$lib/server/export-reviews';

// Downloads everything the signed-in account owns as one markdown archive,
// review feedback included.
export const GET: RequestHandler = async ({ locals }) => {
	const { filename, bytes } = await buildAccountExport(
		db,
		locals.user!.id,
		bucketAssetLoader(db),
		reviewLoader(db)
	);
	return new Response(new Uint8Array(bytes), {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="${filename}"`
		}
	});
};
