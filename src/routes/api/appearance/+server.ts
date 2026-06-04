import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { savePreferences } from '$lib/server/preferences';
import { isTheme } from '$lib/appearance';

// Persists the colour theme for the signed-in user. The avatar-menu toggle
// posts here so a theme change survives the next navigation, where the root
// layout re-applies the saved preference. Accent stays with the account
// Display section; this only touches the theme, and savePreferences merges.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401);
	const body = (await request.json().catch(() => null)) as { theme?: unknown } | null;
	if (!isTheme(body?.theme)) error(400, 'invalid theme');
	await savePreferences(db, locals.user.id, { theme: body.theme });
	return json({ ok: true });
};
