import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { effectiveAssetConfig, s3AssetStore } from '$lib/server/assets';
import {
	clearEntityBadgeImage,
	setEntityBadgeColor,
	setEntityBadgeImage
} from '$lib/server/entity-badge';

// The entity badge: PUT sets a palette colour (null clears it), POST uploads
// an image, DELETE removes the image. Owner-scoped inside the helpers, which
// resolve the id to whichever entity table holds it.

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const body = (await request.json().catch(() => null)) as { color?: unknown } | null;
	const color = body?.color;
	if (color !== null && typeof color !== 'string') error(400, 'color must be a token or null');
	const result = await setEntityBadgeColor(db, locals.user!.id, params.id, color);
	if (!result.ok) error(result.reason === 'entity not found' ? 404 : 400, result.reason);
	return json({ ok: true });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const config = await effectiveAssetConfig(db);
	if (!config) error(503, 'image uploads are not configured');
	const data = await request.formData();
	const file = data.get('file');
	if (!(file instanceof File) || file.size === 0) error(400, 'choose an image to upload');
	const result = await setEntityBadgeImage(
		db,
		s3AssetStore(config),
		config,
		locals.user!.id,
		params.id,
		{
			filename: file.name,
			contentType: file.type,
			bytes: Buffer.from(await file.arrayBuffer())
		}
	);
	if (!result.ok) error(result.reason === 'entity not found' ? 404 : 400, result.reason);
	return json({ id: result.id });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const config = await effectiveAssetConfig(db);
	// With no store we cannot remove the object, but the reference can still go.
	const store = config ? s3AssetStore(config) : null;
	if (!store) error(503, 'image storage is not configured');
	const result = await clearEntityBadgeImage(db, store, locals.user!.id, params.id);
	if (!result.ok) error(result.reason === 'entity not found' ? 404 : 400, result.reason);
	return json({ ok: true });
};
