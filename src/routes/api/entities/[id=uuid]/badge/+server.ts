import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { effectiveAssetConfig, s3AssetStore } from '$lib/server/assets';
import {
	clearEntityBadgeImage,
	setEntityBadgeColor,
	setEntityBadgeImage
} from '$lib/server/entity-badge';
import { rateLimitUploads } from '$lib/server/write-guard';

// The entity badge: PUT sets a palette colour (null clears it), POST uploads
// an image, DELETE removes the image. Owner-scoped inside the helpers, which
// resolve the id to whichever entity table holds it.

// The badge menu shows these to the writer, so the helpers' terse reasons are
// reworded here rather than in the helpers, which other callers share.
const MESSAGES: Record<string, string> = {
	'entity not found': 'This entry no longer exists. Reload the page.',
	'universe not found': 'This entry no longer exists. Reload the page.',
	'not a valid badge colour': 'Pick one of the colours in the menu.',
	'the file is empty': 'That image file is empty. Choose another image.',
	'the file is larger than 10 MB': 'That image is larger than 10 MB. Choose a smaller one.',
	'only png, jpeg, webp, gif, and avif images are supported':
		'Choose a PNG, JPEG, WebP, GIF or AVIF image.'
};

function refuse(reason: string): never {
	const status = reason === 'entity not found' || reason === 'universe not found' ? 404 : 400;
	error(status, MESSAGES[reason] ?? reason);
}

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const body = (await request.json().catch(() => null)) as { color?: unknown } | null;
	const color = body?.color;
	if (color !== null && typeof color !== 'string')
		error(400, 'Pick one of the colours in the menu.');
	const result = await setEntityBadgeColor(db, locals.user!.id, params.id, color);
	if (!result.ok) refuse(result.reason);
	return json({ ok: true });
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
	if (!result.ok) refuse(result.reason);
	return json({ id: result.id });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const config = await effectiveAssetConfig(db);
	// With no store we cannot remove the object, but the reference can still go.
	const store = config ? s3AssetStore(config) : null;
	if (!store) error(503, 'Image storage is not set up on this server.');
	const result = await clearEntityBadgeImage(db, store, locals.user!.id, params.id);
	if (!result.ok) refuse(result.reason);
	return json({ ok: true });
};
