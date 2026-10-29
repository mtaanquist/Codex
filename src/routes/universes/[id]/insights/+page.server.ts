import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { ownedUniverse } from '$lib/server/universe-access';
import {
	entityHeat,
	relationshipLinks,
	storyProgress,
	writingActivity
} from '$lib/server/insights';
import { userPreferences } from '$lib/server/preferences';
import { requestTimeZone } from '$lib/server/timezone';
import { assistantLayout } from '$lib/server/llm/config';
import { listChat } from '$lib/server/llm/chat-history';
import { hasChatSummary } from '$lib/server/llm/chat-summary';

export const load: PageServerLoad = async ({ params, locals, cookies }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	// Day boundaries follow the author's clock. The root layout sets the cookie
	// on first visit and reloads the data once; until then days bucket as UTC.
	const timezone = requestTimeZone(cookies);
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
	const assistantChatSummarised =
		assistant.tabEnabled &&
		(await hasChatSummary(db, locals.user!.id, { universeId: universe.id }));
	return {
		universe,
		stories,
		heat,
		activity,
		web,
		assistant,
		assistantChat,
		assistantChatSummarised,
		dailyGoal: preferences.dailyWordGoal,
		showStreak: preferences.sessionStreak === 'shown'
	};
};
