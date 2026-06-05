import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { stories, universes } from '$lib/server/db/schema';
import { storyTimeline } from '$lib/server/revisions';
import { assetConfig, createAsset, deleteAsset, s3AssetStore } from '$lib/server/assets';
import { publishStory } from '$lib/server/publish';
import { listEditionArtifacts, setDownloadsPublic } from '$lib/server/export-artifacts';
import {
	createReviewInvitation,
	listReviewInvitations,
	revokeReviewInvitation
} from '$lib/server/review';
import { queueExportArtifacts } from '$lib/server/jobs';
import { deleteStory } from '$lib/server/story-delete';
import { publications, users } from '$lib/server/db/schema';

async function ownedStory(storyId: string, userId: string) {
	const [row] = await db
		.select({ story: stories, universe: universes })
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
	if (!row) error(404, 'Story not found');
	return row;
}

// The current edition, if the story has been published.
async function currentEdition(storyId: string) {
	const [edition] = await db
		.select({
			id: publications.id,
			versionLabel: publications.versionLabel,
			downloadsPublic: publications.downloadsPublic,
			publishedAt: publications.publishedAt
		})
		.from(publications)
		.where(and(eq(publications.storyId, storyId), eq(publications.isCurrent, true)));
	return edition ?? null;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);
	const timeline = await storyTimeline(db, story.id, 30);
	const [archive] = await db
		.select({ handle: users.handle, enabled: users.publicArchiveEnabled })
		.from(users)
		.where(eq(users.id, locals.user!.id));
	const edition = await currentEdition(story.id);
	return {
		story,
		universe,
		timeline,
		assetsConfigured: assetConfig() !== null,
		archive,
		edition,
		artifacts: edition ? await listEditionArtifacts(db, edition.id) : [],
		reviewInvitations: await listReviewInvitations(db, story.id)
	};
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
		// The worker stores the edition's download files; best-effort, since the
		// settings page offers "generate again" if they never appear.
		if (assetConfig()) await queueExportArtifacts(result.publicationId);
		return { action: 'publish', published: true };
	},
	regenerateExports: async ({ params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const edition = await currentEdition(story.id);
		if (!edition) {
			return fail(400, { action: 'exports', message: 'Publish an edition first.' });
		}
		if (!assetConfig()) {
			return fail(400, { action: 'exports', message: 'Assets are not configured on this server.' });
		}
		if (!(await queueExportArtifacts(edition.id))) {
			return fail(500, { action: 'exports', message: 'Could not queue the export run.' });
		}
		return { action: 'exports', queued: true };
	},
	setDownloads: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const edition = await currentEdition(story.id);
		if (!edition) {
			return fail(400, { action: 'exports', message: 'Publish an edition first.' });
		}
		const data = await request.formData();
		await setDownloadsPublic(db, locals.user!.id, edition.id, data.get('downloadsPublic') === 'on');
		return { action: 'exports', saved: true };
	},
	createReviewInvite: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const expiresRaw = String(data.get('expiresDays') ?? '').trim();
		const expiresDays = expiresRaw === '' ? 0 : Number(expiresRaw);
		if (!Number.isInteger(expiresDays) || expiresDays < 0 || expiresDays > 365) {
			return fail(400, {
				action: 'review',
				message: 'Leave expiry blank for a link that does not expire, or use 1 to 365 days.'
			});
		}
		const { token } = await createReviewInvitation(db, {
			storyId: story.id,
			createdBy: locals.user!.id,
			email: String(data.get('note') ?? ''),
			canSuggest: data.get('canSuggest') === 'on',
			expiresAt: expiresDays > 0 ? new Date(Date.now() + expiresDays * 86_400_000) : null
		});
		// The raw token exists only in this response; the row keeps its hash.
		return { action: 'review', reviewLink: `/review/${token}` };
	},
	revokeReviewInvite: async ({ request, params, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const invitationId = String(data.get('invitationId') ?? '');
		const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		if (
			!UUID.test(invitationId) ||
			!(await revokeReviewInvitation(db, locals.user!.id, invitationId))
		) {
			return fail(400, { action: 'review', message: 'That invitation could not be revoked.' });
		}
		return { action: 'review', revoked: true };
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
		// Clears every story-scoped row first; a plain delete 500s on the FKs
		// the moment the story has any content or a published edition.
		await deleteStory(db, story.id, locals.user!.id);
		redirect(303, `/universes/${story.universeId}`);
	}
};
