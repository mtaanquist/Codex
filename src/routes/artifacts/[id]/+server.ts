import { error } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { effectiveAssetConfig, s3AssetStore } from '$lib/server/assets';
import { artifactForDownload } from '$lib/server/export-artifacts';

// Streams a stored export file (markdown zip, EPUB, PDF): to the edition's
// owner always, and to anyone when the edition is readable and the owner has
// switched reader downloads on. artifactForDownload owns those rules.
export const GET: RequestHandler = async ({ params, locals }) => {
	const config = await effectiveAssetConfig(db);
	if (!config) error(503, 'assets are not configured');

	const artifact = await artifactForDownload(db, params.id, locals.user?.id ?? null);
	if (!artifact) error(404, 'Not found');

	const store = s3AssetStore(config);
	const body = await store.get(artifact.storageKey);

	return new Response(Readable.toWeb(body) as ReadableStream, {
		headers: {
			'content-type': artifact.contentType,
			// No content-length: regeneration overwrites the bytes behind the same
			// id and the stored byteSize can lag the live object, so a fixed length
			// could truncate the download. The body streams chunked instead.
			'content-disposition': `attachment; filename="${artifact.filename}"`,
			// Regeneration replaces the bytes behind the same id, and public
			// reachability can flip (takedown, downloads switched off), so nothing
			// caches for long.
			'cache-control': 'private, max-age=300, must-revalidate',
			'x-content-type-options': 'nosniff'
		}
	});
};
