import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { users } from '#lib/server/db/schema';
import { ownedStory } from '#lib/server/story-access';
import { readingPageRef } from '#lib/server/publish';
import {
	compareWithDraft,
	getDraft,
	listDrafts,
	workingOutline,
	newStoryFromDraft,
	restoreDraftScene
} from '#lib/server/story-drafts';
import { queueSceneMentions, queueUniverseMentions } from '#lib/server/jobs';
import { formText } from '#lib/server/validation';
import { rateLimitWrites } from '#lib/server/write-guard';
import { isUuid } from '#lib/slug';
import { detectMentions, type MentionTarget } from '#lib/mention-detect';
import { matchScenes } from '#lib/drafts';
import { listTrashedScenes } from '#lib/server/scene-lifecycle';

// The working draft's text for each saved scene, paired the same way the
// Compare tab pairs them.
function liveByDraftScene(
	saved: { id: string }[],
	live: { id: string; bodyMd: string; origin?: string | null; root?: string | null }[]
): Record<string, string> {
	const pairs = matchScenes(saved, live);
	const result: Record<string, string> = {};
	for (const scene of live) {
		const savedId = pairs.get(scene.id);
		if (savedId) result[savedId] = scene.bodyMd;
	}
	return result;
}

const TABS = ['story', 'world', 'notes', 'compare'] as const;
type Tab = (typeof TABS)[number];

// A saved draft, read-only. Nothing on this page changes the draft, and the
// only things that change the working draft (restoring a scene) keep the
// replaced text in History.
export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);
	const draft = await getDraft(db, story.id, params.draft);
	if (!draft) error(404, 'That saved draft no longer exists.');
	const tabParam = url.searchParams.get('tab');
	const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'story';

	const [drafts, liveScenes, trashed, reading, [archive]] = await Promise.all([
		listDrafts(db, story.id),
		// The working draft's text for each scene, to compare against and to
		// say which scenes have changed since.
		tab === 'story'
			? workingOutline(db, story.id).then((outline) => outline.scenes)
			: Promise.resolve([]),
		// Saved scenes that sit in the deleted list, so the page can point there
		// before offering to add a second copy.
		tab === 'story' ? listTrashedScenes(db, story.id) : Promise.resolve([]),
		readingPageRef(db, story.id),
		db
			.select({ enabled: users.publicArchiveEnabled, handle: users.handle })
			.from(users)
			.where(eq(users.id, locals.user!.id))
	]);

	// How often each frozen entity is named in the frozen prose, by the same
	// rules as the live underlines.
	const mentions: Record<string, number> = {};
	if (tab === 'world') {
		const targets: MentionTarget[] = draft.content.entities.map((entity) => ({
			id: entity.id,
			type: entity.type,
			names: [entity.name, ...entity.aliases]
		}));
		const members = new Set(
			draft.content.entities.filter((entity) => entity.inStory).map((entity) => entity.id)
		);
		for (const scene of draft.content.scenes) {
			for (const match of detectMentions(scene.bodyMd, targets, { storyMembers: members })) {
				mentions[match.targetId] = (mentions[match.targetId] ?? 0) + 1;
			}
		}
	}

	const compare =
		tab === 'compare'
			? await compareWithDraft(db, story.id, draft, url.searchParams.get('with'))
			: null;

	return {
		compare,
		story,
		universe,
		reading,
		// The compare tab carries its own scenes; the draft's are not needed.
		draft:
			tab === 'compare'
				? {
						...draft,
						content: { ...draft.content, scenes: [], entities: [], relationships: [], notes: [] }
					}
				: draft,
		drafts: drafts.map((row) => ({ id: row.id, label: row.label })),
		live: liveByDraftScene(draft.content.scenes, liveScenes),
		inTrash: trashed.map((scene) => scene.id),
		mentions,
		tab,
		canPublish: Boolean(archive?.enabled && archive?.handle)
	};
};

export const actions: Actions = {
	restoreScene: async ({ request, params, locals }) => {
		rateLimitWrites(locals.user!.id);
		const { story } = await ownedStory(params.id, locals.user!.id);
		const sceneId = formText(await request.formData(), 'sceneId');
		if (!isUuid(sceneId)) {
			return fail(400, { action: 'restore', message: 'That scene is not in this draft.' });
		}
		const result = await restoreDraftScene(db, story.id, params.draft, sceneId);
		if (!result.ok) return fail(400, { action: 'restore', sceneId, message: result.reason });
		await queueSceneMentions(result.sceneId);
		return {
			action: 'restore',
			sceneId,
			restoredSceneId: result.sceneId,
			created: result.created
		};
	},
	newStory: async ({ request, params, locals }) => {
		rateLimitWrites(locals.user!.id);
		const { story, universe } = await ownedStory(params.id, locals.user!.id);
		const title = formText(await request.formData(), 'title');
		const result = await newStoryFromDraft(db, locals.user!.id, story, params.draft, title);
		if (!result.ok) return fail(400, { action: 'newStory', message: result.reason });
		await queueUniverseMentions(universe.id);
		redirect(303, `/stories/${result.slug}`);
	}
};
