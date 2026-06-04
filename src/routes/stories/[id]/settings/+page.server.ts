import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { stories, universes } from '$lib/server/db/schema';
import { storyTimeline } from '$lib/server/revisions';
import { assetConfig, createAsset, deleteAsset, s3AssetStore } from '$lib/server/assets';
import { publishStory } from '$lib/server/publish';
import { users } from '$lib/server/db/schema';

async function ownedStory(storyId: string, userId: string) {
	const [row] = await db
		.select({ story: stories, universe: universes })
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
	if (!row) error(404, 'Story not found');
	return row;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);
	const timeline = await storyTimeline(db, story.id, 30);
	const [archive] = await db
		.select({ handle: users.handle, enabled: users.publicArchiveEnabled })
		.from(users)
		.where(eq(users.id, locals.user!.id));
	return { story, universe, timeline, assetsConfigured: assetConfig() !== null, archive };
};

export const actions: Actions = {
	update: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		const author = String(data.get('author') ?? '').trim() || null;
		const brief = String(data.get('brief') ?? '').trim() || null;
		const descriptionMd = String(data.get('description') ?? '').trim() || null;
		if (!title) {
			return fail(400, { action: 'update', message: 'The story needs a title.' });
		}
		await db
			.update(stories)
			.set({ title, author, brief, descriptionMd })
			.where(eq(stories.id, story.id));
		return { action: 'update', saved: true };
	},
	setVisibility: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const visibility = String(data.get('visibility') ?? '');
		if (visibility !== 'private' && visibility !== 'unlisted' && visibility !== 'public') {
			return fail(400, { action: 'publish', message: 'Pick a visibility.' });
		}
		const isAdult = data.get('isAdult') === 'on';
		await db.update(stories).set({ visibility, isAdult }).where(eq(stories.id, story.id));
		return { action: 'publish', saved: true };
	},
	publish: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const versionLabel = String(data.get('versionLabel') ?? '');
		const result = await publishStory(db, locals.user!.id, story.id, versionLabel);
		if (!result.ok) {
			return fail(400, { action: 'publish', message: result.reason });
		}
		return { action: 'publish', published: true };
	},
	setCover: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const config = assetConfig();
		if (!config) {
			return fail(400, { action: 'cover', message: 'Assets are not configured on this server.' });
		}
		const data = await request.formData();
		const file = data.get('cover');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { action: 'cover', message: 'Choose an image file.' });
		}
		const store = s3AssetStore(config);
		const created = await createAsset(db, store, config, locals.user!.id, {
			universeId: story.universeId,
			kind: 'cover',
			filename: file.name,
			contentType: file.type,
			bytes: Buffer.from(await file.arrayBuffer())
		});
		if (!created.ok) {
			return fail(400, { action: 'cover', message: created.reason });
		}
		const previous = story.coverAssetId;
		await db.update(stories).set({ coverAssetId: created.id }).where(eq(stories.id, story.id));
		// The replaced cover has no other references; clean it up.
		if (previous) await deleteAsset(db, store, locals.user!.id, previous);
		return { action: 'cover', saved: true };
	},
	delete: async ({ params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		await db.delete(stories).where(eq(stories.id, story.id));
		redirect(303, `/universes/${story.universeId}`);
	}
};
