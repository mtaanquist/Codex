import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { savePreferences, type UserPreferences } from '$lib/server/preferences';

// Persists the prose editor's view toggles (the non-printing marks and the
// command-marker visibility) for the signed-in user. The formatting toolbar
// posts here so a toggle survives the next navigation; savePreferences merges,
// so only the keys sent are touched.
const SHOWN_HIDDEN = new Set(['shown', 'hidden']);
const KEYS = ['nonPrintingMarks', 'commandMarkers'] as const;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401);
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) error(400, 'invalid body');
	const patch: Partial<UserPreferences> = {};
	for (const key of KEYS) {
		const value = body[key];
		if (value === undefined) continue;
		if (typeof value !== 'string' || !SHOWN_HIDDEN.has(value)) error(400, `invalid ${key}`);
		patch[key] = value as 'shown' | 'hidden';
	}
	if (Object.keys(patch).length === 0) error(400, 'nothing to save');
	await savePreferences(db, locals.user.id, patch);
	return json({ ok: true });
};
