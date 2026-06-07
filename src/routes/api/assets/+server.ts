import { error, json } from '@sveltejs/kit';
import { throwActionError } from '$lib/server/action-result';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { effectiveAssetConfig, createAsset, s3AssetStore } from '$lib/server/assets';
import { rateLimitUploads } from '$lib/server/write-guard';

// Accepts an image upload (multipart form: file, kind, universeId) and
// returns the app-served path for it.
export const POST: RequestHandler = async ({ request, locals }) => {
	rateLimitUploads(locals.user!.id);
	const config = await effectiveAssetConfig(db);
	if (!config) error(503, 'assets are not configured; set the ASSET_S3_* variables');

	const form = await request.formData();
	const file = form.get('file');
	const kind = String(form.get('kind') ?? 'inline');
	const universeId = String(form.get('universeId') ?? '') || null;
	if (!(file instanceof File)) error(400, 'a file is required');
	if (kind !== 'inline' && kind !== 'cover') error(400, 'kind must be inline or cover');

	const result = await createAsset(db, s3AssetStore(config), config, locals.user!.id, {
		universeId,
		kind,
		filename: file.name,
		contentType: file.type,
		bytes: Buffer.from(await file.arrayBuffer())
	});
	if (!result.ok) {
		throwActionError(result);
	}
	return json({ id: result.id, path: `/assets/${result.id}` }, { status: 201 });
};
