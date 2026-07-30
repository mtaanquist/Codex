import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { ownedUniverse } from '$lib/server/universe-access';
import {
	entityHeat,
	isValidTimezone,
	relationshipLinks,
	storyProgress,
	writingActivity
} from '$lib/server/insights';
import { userPreferences } from '$lib/server/preferences';
import { assistantLayout } from '$lib/server/llm/config';
import { listChat } from '$lib/server/llm/chat-history';

export const load: PageServerLoad = async ({ params, locals, cookies }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	// Day boundaries follow the author's clock. The page sets this cookie on
	// first visit and reloads the data once; until then days bucket as UTC. A
	// malformed cookie (bad percent-escape) must fall back to UTC, not 500.
	let requested: string;
	try {
		requested = decodeURIComponent(cookies.get('codex-tz') ?? '');
	} catch {
		requested = '';
	}
	const timezone = requested && isValidTimezone(requested) ? requested : 'UTC';
	const [stories, heat, activity, web, preferences, assistant] = await Promise.all([
		storyProgress(db, universe.id),
		entityHeat(db, universe.id),
		writingActivity(db, universe.id, timezone),
		relationshipLinks(db, universe.id),
		userPreferences(db, locals.user!.id),
		assistantLayout(db, locals.user!.id)
	]);
	// The Assistant is the one panel with a subject on this page: the numbers in
	// the middle. Nothing to load while the account has it switched off.
	const assistantChat = assistant.tabEnabled
		? await listChat(db, locals.user!.id, { universeId: universe.id })
		: [];
	return {
		universe,
		timezone,
		stories,
		heat,
		activity,
		web,
		assistant,
		assistantChat,
		dailyGoal: preferences.dailyWordGoal,
		showStreak: preferences.sessionStreak === 'shown'
	};
};
