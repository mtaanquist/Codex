import { error } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import { assetConfig, openAsset, s3AssetStore } from '$lib/server/assets';
import { isPublishedCover } from '$lib/server/publish';

// Streams an uploaded asset: to its owner always, and to anyone when it
// is the cover of a publicly readable edition. Assets never change once
// uploaded, so the browser may cache them hard.
export const GET: RequestHandler = async ({ params, locals }) => {
	const config = assetConfig();
	if (!config) error(503, 'assets are not configured');
	const store = s3AssetStore(config);

	let opened = locals.user ? await openAsset(db, store, locals.user.id, params.id) : null;
	let privacy = 'private';
	if (!opened && (await isPublishedCover(db, params.id))) {
		const [row] = await db.select().from(assets).where(eq(assets.id, params.id));
		if (row) {
			opened = { asset: row, body: await store.get(row.storageKey) };
			privacy = 'public';
		}
	}
	if (!opened) error(404, 'asset not found');

	return new Response(Readable.toWeb(opened.body) as ReadableStream, {
		headers: {
			'content-type': opened.asset.contentType,
			'content-length': String(opened.asset.byteSize),
			'cache-control': `${privacy}, max-age=31536000, immutable`,
			'x-content-type-options': 'nosniff'
		}
	});
};
