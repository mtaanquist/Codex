import { error } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assetConfig, openAsset, s3AssetStore } from '$lib/server/assets';

// Streams an uploaded asset back to its owner. Assets never change once
// uploaded, so the browser may cache them hard.
export const GET: RequestHandler = async ({ params, locals }) => {
	const config = assetConfig();
	if (!config) error(503, 'assets are not configured');
	const opened = await openAsset(db, s3AssetStore(config), locals.user!.id, params.id);
	if (!opened) error(404, 'asset not found');
	return new Response(Readable.toWeb(opened.body) as ReadableStream, {
		headers: {
			'content-type': opened.asset.contentType,
			'content-length': String(opened.asset.byteSize),
			'cache-control': 'private, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff'
		}
	});
};
