import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db';
import { userPreferences } from '$lib/server/preferences';

// The signed-in user's appearance, so the layout can apply the saved theme and
// accent across the app and on a fresh device. Null for guests, who keep the
// pre-paint script's per-device choice.
export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) return { appearance: null };
	const prefs = await userPreferences(db, locals.user.id);
	return { appearance: { theme: prefs.theme, accent: prefs.accent } };
};
