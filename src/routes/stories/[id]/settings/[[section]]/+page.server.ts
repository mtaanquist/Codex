import { error, fail, redirect } from '@sveltejs/kit';
import { isUuid } from '$lib/slug';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db, isUniqueViolation } from '$lib/server/db';
import { stories } from '$lib/server/db/schema';
import { storyTimeline } from '$lib/server/revisions';
import { effectiveAssetConfig, createAsset, deleteAsset, s3AssetStore } from '$lib/server/assets';
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
import {
	saveStoryPreferences,
	storyPreferenceOverrides,
	userPreferences
} from '$lib/server/preferences';
import { saveStoryPageSetup, storyPageSetupOverrides, userPageSetup } from '$lib/server/page-setup';
import {
	FONT_SIZES,
	GUTTERS,
	LINE_SPACINGS,
	PAGE_FONTS,
	PAGE_MARGINS,
	PAGE_SIZES
} from '$lib/page-setup';
import { ownedStory } from '$lib/server/story-access';
import { uniqueSlug } from '$lib/server/slugs';

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

const SECTIONS = [
	'editor',
	'pagesetup',
	'goals',
	'cover',
	'publish',
	'review',
	'export',
	'history',
	'danger'
];

export const load: PageServerLoad = async ({ params, locals }) => {
	// Details rests on /settings itself; the other sections have their own page.
	if (params.section !== undefined && !SECTIONS.includes(params.section)) error(404, 'Not found');
	const { story, universe } = await ownedStory(params.id, locals.user!.id);
	// These reads are independent; only the artifact list depends on the
	// edition, so run the rest together and fetch artifacts after.
	const [
		timeline,
		[archive],
		edition,
		reviewInvitations,
		preferenceOverrides,
		accountPreferences,
		pageSetupOverrides,
		accountPageSetup
	] = await Promise.all([
		storyTimeline(db, story.id, 30),
		db
			.select({ handle: users.handle, enabled: users.publicArchiveEnabled })
			.from(users)
			.where(eq(users.id, locals.user!.id)),
		currentEdition(story.id),
		listReviewInvitations(db, story.id),
		storyPreferenceOverrides(db, story.id),
		userPreferences(db, locals.user!.id),
		storyPageSetupOverrides(db, story.id),
		userPageSetup(db, locals.user!.id)
	]);
	const assetsConfigured = (await effectiveAssetConfig(db)) !== null;
	// These sections hide when their feature is off, so their pages do too.
	if (params.section === 'cover' && !assetsConfigured) error(404, 'Not found');
	if (params.section === 'publish' && !(archive?.enabled && archive?.handle))
		error(404, 'Not found');
	return {
		story,
		universe,
		timeline,
		assetsConfigured,
		archive,
		edition,
		artifacts: edition ? await listEditionArtifacts(db, edition.id) : [],
		reviewInvitations,
		// For the Editor section: which keys this story overrides, and the
		// account values the inherit options fall back to.
		preferenceOverrides,
		accountPreferences,
		// Same shape for the Page setup section.
		pageSetupOverrides,
		accountPageSetup
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
		// The slug follows the title: a rename moves the story's URL, an
		// unchanged title leaves it alone.
		const save = async (slug: string) => {
			await db
				.update(stories)
				.set({ title, slug, author, brief, descriptionMd })
				.where(eq(stories.id, story.id));
			return slug;
		};
		const freshSlug = () => uniqueSlug(db, 'stories', locals.user!.id, title, 'story');
		let slug;
		try {
			slug = await save(title === story.title ? story.slug : await freshSlug());
		} catch (err) {
			// A concurrent create took the slug between the pick and the update.
			if (!isUniqueViolation(err)) throw err;
			slug = await save(await freshSlug());
		}
		// A changed slug moves this page's own URL.
		if (slug !== story.slug) redirect(303, `/stories/${slug}/settings`);
		return { action: 'update', saved: true };
	},
	saveGoals: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const rawTarget = String(data.get('targetWords') ?? '').trim();
		const rawDeadline = String(data.get('deadline') ?? '').trim();
		let targetWords: number | null = null;
		if (rawTarget !== '') {
			const n = Number(rawTarget);
			if (!Number.isFinite(n) || n < 0) {
				return fail(400, { action: 'goals', message: 'Enter a word target of zero or more.' });
			}
			targetWords = Math.trunc(n) > 0 ? Math.trunc(n) : null;
		}
		const deadline = /^\d{4}-\d{2}-\d{2}$/.test(rawDeadline) ? rawDeadline : null;
		await db.update(stories).set({ targetWords, deadline }).where(eq(stories.id, story.id));
		return { action: 'goals', saved: true };
	},
	savePreferences: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const mode = String(data.get('entityAutocomplete') ?? '');
		const marks = String(data.get('continuousSceneMarks') ?? '');
		const editing = String(data.get('editingMode') ?? '');
		const spell = String(data.get('spellCheck') ?? '');
		// The "browser" sentinel distinguishes an explicit follow-the-browser
		// override from inheriting the account language.
		const languageRaw = String(data.get('writingLanguage') ?? '');
		// An empty value clears the override, so the account setting applies.
		if (mode !== '' && mode !== 'popup' && mode !== 'ghost' && mode !== 'off') {
			return fail(400, { action: 'prefs', message: 'Pick an autocomplete option.' });
		}
		if (marks !== '' && marks !== 'shown' && marks !== 'hidden') {
			return fail(400, { action: 'prefs', message: 'Pick a scene marks option.' });
		}
		if (editing !== '' && editing !== 'markdown' && editing !== 'rich') {
			return fail(400, { action: 'prefs', message: 'Pick an editing mode.' });
		}
		if (spell !== '' && spell !== 'on' && spell !== 'off') {
			return fail(400, { action: 'prefs', message: 'Pick a spell-check option.' });
		}
		await saveStoryPreferences(db, story.id, {
			entityAutocomplete: mode || null,
			continuousSceneMarks: marks || null,
			editingMode: editing || null,
			spellCheck: spell || null,
			writingLanguage: languageRaw === '' ? null : languageRaw === 'browser' ? '' : languageRaw
		});
		return { action: 'prefs', saved: true };
	},
	savePageSetup: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		// An empty value clears the override, so the account setting applies.
		// Enum values outside the option tables clear too, rather than storing
		// junk for the normaliser to clean up later.
		const enumValue = (name: string, table: Record<string, unknown>) => {
			const value = String(data.get(name) ?? '');
			return value !== '' && value in table ? value : null;
		};
		const triState = (name: string) => {
			const value = String(data.get(name) ?? '');
			return value === 'on' ? true : value === 'off' ? false : null;
		};
		const fontSizeRaw = String(data.get('fontSize') ?? '');
		const fontSize = FONT_SIZES.includes(Number(fontSizeRaw) as (typeof FONT_SIZES)[number])
			? Number(fontSizeRaw)
			: null;
		await saveStoryPageSetup(db, story.id, {
			pageSize: enumValue('pageSize', PAGE_SIZES),
			margins: enumValue('margins', PAGE_MARGINS),
			font: enumValue('font', PAGE_FONTS),
			fontSize,
			paragraphStyle: enumValue('paragraphStyle', { indent: true, spaced: true }),
			lineSpacing: enumValue('lineSpacing', LINE_SPACINGS),
			gutter: enumValue('gutter', GUTTERS),
			sceneBreak:
				String(data.get('sceneBreakMode') ?? '') === 'custom'
					? String(data.get('sceneBreak') ?? '')
							.trim()
							.slice(0, 20)
					: null,
			pageNumbers: triState('pageNumbers'),
			runningHeader: triState('runningHeader')
		});
		return { action: 'pagesetup', saved: true };
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
		if (await effectiveAssetConfig(db)) await queueExportArtifacts(result.publicationId);
		return { action: 'publish', published: true };
	},
	regenerateExports: async ({ params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const edition = await currentEdition(story.id);
		if (!edition) {
			return fail(400, { action: 'exports', message: 'Publish an edition first.' });
		}
		if (!(await effectiveAssetConfig(db))) {
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
		if (
			!isUuid(invitationId) ||
			!(await revokeReviewInvitation(db, locals.user!.id, invitationId))
		) {
			return fail(400, { action: 'review', message: 'That invitation could not be revoked.' });
		}
		return { action: 'review', revoked: true };
	},
	setCover: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const config = await effectiveAssetConfig(db);
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
		const { story, universe } = await ownedStory(params.id, locals.user!.id);
		// Clears every story-scoped row first; a plain delete 500s on the FKs
		// the moment the story has any content or a published edition. The store
		// sweeps the edition export files left behind in the bucket.
		const config = await effectiveAssetConfig(db);
		await deleteStory(db, story.id, locals.user!.id, config ? s3AssetStore(config) : null);
		redirect(303, `/universes/${universe.slug}`);
	}
};
