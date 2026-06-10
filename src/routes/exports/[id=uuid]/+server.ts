import { error } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { effectiveAssetConfig, s3AssetStore } from '$lib/server/assets';
import { exportForDownload } from '$lib/server/user-exports';

// Streams a finished user export to its owner. The file was built in the
// worker and stored in the asset bucket; this only checks ownership and
// streams the bytes, so the heavy build never touches the web request path.
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(404, 'Not found');
	const config = await effectiveAssetConfig(db);
	if (!config) error(503, 'assets are not configured');

	const row = await exportForDownload(db, params.id, locals.user.id);
	if (!row || !row.storageKey) error(404, 'Not found');

	const store = s3AssetStore(config);
	const body = await store.get(row.storageKey);

	return new Response(Readable.toWeb(body) as ReadableStream, {
		headers: {
			'content-type': row.contentType ?? 'application/octet-stream',
			'content-disposition': `attachment; filename="${row.filename ?? 'export'}"`,
			// Owner-only and short-lived; never cache.
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
