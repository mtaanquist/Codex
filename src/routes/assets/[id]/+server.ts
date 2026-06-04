import { error } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import { assetConfig, openAsset, s3AssetStore } from '$lib/server/assets';
import { isPublicAsset } from '$lib/server/publish';

// Streams an uploaded asset: to its owner always, and to anyone when it
// belongs to a publicly readable edition (cover or inline image).
export const GET: RequestHandler = async ({ params, locals }) => {
	const config = assetConfig();
	if (!config) error(503, 'assets are not configured');
	const store = s3AssetStore(config);

	let opened = locals.user ? await openAsset(db, store, locals.user.id, params.id) : null;
	let isPublic = false;
	if (!opened && (await isPublicAsset(db, params.id))) {
		const [row] = await db.select().from(assets).where(eq(assets.id, params.id));
		if (row) {
			opened = { asset: row, body: await store.get(row.storageKey) };
			isPublic = true;
		}
	}
	if (!opened) error(404, 'asset not found');

	// The bytes never change, but public reachability does (takedown,
	// visibility flip), and the URL is keyed only by id. So the owner's
	// own request caches hard, while the public copy revalidates quickly
	// enough that a takedown is not defeated by a year-long cache.
	const cacheControl = isPublic
		? 'public, max-age=300, must-revalidate'
		: 'private, max-age=31536000, immutable';

	return new Response(Readable.toWeb(opened.body) as ReadableStream, {
		headers: {
			'content-type': opened.asset.contentType,
			'content-length': String(opened.asset.byteSize),
			'cache-control': cacheControl,
			'x-content-type-options': 'nosniff'
		}
	});
};
