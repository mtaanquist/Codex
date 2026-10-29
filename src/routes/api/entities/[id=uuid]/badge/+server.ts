import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { effectiveAssetConfig, s3AssetStore } from '$lib/server/assets';
import {
	clearEntityBadgeImage,
	setEntityBadgeColor,
	setEntityBadgeImage
} from '$lib/server/entity-badge';
import { rateLimitUploads } from '$lib/server/write-guard';
import { throwActionError } from '$lib/server/action-result';
import { readJson } from '$lib/server/validation';

// The entity badge: PUT sets a palette colour (null clears it), POST uploads
// an image, DELETE removes the image. Owner-scoped inside the helpers, which
// resolve the id to whichever entity table holds it.

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const { color } = await readJson<{ color?: unknown }>(request);
	if (color !== null && typeof color !== 'string')
		error(400, 'Pick one of the colours in the menu.');
	const result = await setEntityBadgeColor(db, locals.user!.id, params.id, color);
	if (!result.ok) throwActionError(result);
	return Response.json({ ok: true });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	rateLimitUploads(locals.user!.id);
	const config = await effectiveAssetConfig(db);
	if (!config) error(503, 'Image uploads are not set up on this server.');
	const data = await request.formData();
	const file = data.get('file');
	if (!(file instanceof File) || file.size === 0) error(400, 'Choose an image to upload.');
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
	if (!result.ok) throwActionError(result);
	return Response.json({ id: result.id });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const result = await clearEntityBadgeImage(db, locals.user!.id, params.id);
	if (!result.ok) throwActionError(result);
	return Response.json({ ok: true });
};
