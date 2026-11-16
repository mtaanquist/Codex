import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { scenes, users } from '#lib/server/db/schema';
import { ownedStory } from '#lib/server/story-access';
import { readingPageRef } from '#lib/server/publish';
import {
	FROM_DRAFT_SCENE,
	getDraft,
	listDrafts,
	newStoryFromDraft,
	restoreDraftScene
} from '#lib/server/story-drafts';
import { queueSceneMentions, queueUniverseMentions } from '#lib/server/jobs';
import { formText } from '#lib/server/validation';
import { rateLimitWrites } from '#lib/server/write-guard';
import { isUuid } from '#lib/slug';
import { detectMentions, type MentionTarget } from '#lib/mention-detect';

// The working draft's text for each saved scene. A scene that was added back
// from a draft has a new id, so it is found by the id it came from.
function liveByDraftScene(
	saved: { id: string }[],
	live: { id: string; bodyMd: string; metadata: unknown }[]
): Record<string, string> {
	const byId = new Map<string, string>();
	for (const scene of live) {
		const from = (scene.metadata as Record<string, unknown>)[FROM_DRAFT_SCENE];
		if (typeof from === 'string' && !byId.has(from)) byId.set(from, scene.bodyMd);
	}
	for (const scene of live) byId.set(scene.id, scene.bodyMd);
	const result: Record<string, string> = {};
	for (const scene of saved) {
		const body = byId.get(scene.id);
		if (body !== undefined) result[scene.id] = body;
	}
	return result;
}

const TABS = ['story', 'world', 'notes'] as const;
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

	const [drafts, liveScenes, reading, [archive]] = await Promise.all([
		listDrafts(db, story.id),
		// The working draft's text for each scene, to compare against and to
		// say which scenes have changed since.
		tab === 'story'
			? db
					.select({ id: scenes.id, bodyMd: scenes.bodyMd, metadata: scenes.metadata })
					.from(scenes)
					.where(and(eq(scenes.storyId, story.id), isNull(scenes.deletedAt)))
			: Promise.resolve([]),
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

	return {
		story,
		universe,
		reading,
		draft,
		drafts: drafts.map((row) => ({ id: row.id, label: row.label })),
		live: liveByDraftScene(draft.content.scenes, liveScenes),
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
