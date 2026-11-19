import { error, fail, redirect } from '@sveltejs/kit';
import { isUuid } from '#lib/slug';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { stories } from '#lib/server/db/schema';
import { storyTimeline } from '#lib/server/revisions';
import { effectiveAssetConfig, createAsset, deleteAsset, s3AssetStore } from '#lib/server/assets';
import { publishStory } from '#lib/server/publish';
import {
	deleteDraft,
	listDrafts,
	replaceCover,
	saveDraft,
	updateDraftDetails
} from '#lib/server/story-drafts';
import { rateLimitWrites } from '#lib/server/write-guard';
import { setPenNameIfUnset } from '#lib/server/account';
import { listEditionArtifacts, setDownloadsPublic } from '#lib/server/export-artifacts';
import {
	createReviewInvitation,
	listReviewInvitations,
	revokeReviewInvitation
} from '#lib/server/review';
import { queueExportArtifacts, queueUserExport } from '#lib/server/jobs';
import {
	listUserExports,
	markExportFailed,
	requestExport,
	type ExportFormat
} from '#lib/server/user-exports';
import { exportLimit, uploadLimit } from '#lib/server/rate-limit';
import { STORY_TRASH_DAYS, trashStory } from '#lib/server/story-lifecycle';
import { saveStoryDetails } from '#lib/server/story-details';
import { publications, users } from '#lib/server/db/schema';
import {
	saveStoryPreferences,
	storyPreferenceOverrides,
	userPreferences
} from '#lib/server/preferences';
import { saveStoryPageSetup, storyPageSetupOverrides, userPageSetup } from '#lib/server/page-setup';
import {
	FONT_SIZES,
	GUTTERS,
	LINE_SPACING_CM_MAX,
	LINE_SPACING_CM_MIN,
	LINE_SPACINGS,
	PAGE_FONTS,
	PAGE_MARGINS,
	PAGE_SIZES,
	TEXT_ALIGNS
} from '#lib/page-setup';
import { ownedStory } from '#lib/server/story-access';
import { assistantLayout } from '#lib/server/llm/config';
import { formText } from '#lib/server/validation';
import { isCoverColor } from '#lib/entity-color';

// The current edition, if the story has been published.
async function currentEdition(storyId: string) {
	const [edition] = await db
		.select({
			id: publications.id,
			versionLabel: publications.versionLabel,
			downloadsPublic: publications.downloadsPublic,
			publishedAt: publications.publishedAt,
			artifactErrors: publications.artifactErrors
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
	'drafts',
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
		accountPageSetup,
		assistant,
		drafts
	] = await Promise.all([
		storyTimeline(db, story.id, 30),
		db
			.select({
				handle: users.handle,
				enabled: users.publicArchiveEnabled,
				penName: users.penName
			})
			.from(users)
			.where(eq(users.id, locals.user!.id)),
		currentEdition(story.id),
		listReviewInvitations(db, story.id),
		storyPreferenceOverrides(db, story.id),
		userPreferences(db, locals.user!.id),
		storyPageSetupOverrides(db, story.id),
		userPageSetup(db, locals.user!.id),
		assistantLayout(db, locals.user!.id, story.id),
		listDrafts(db, story.id)
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
		trashDays: STORY_TRASH_DAYS,
		assetsConfigured,
		archive,
		// The first publish with no pen name set asks what name goes public.
		displayName: locals.user!.displayName,
		edition,
		reading: edition && archive?.handle ? { handle: archive.handle, storyId: story.id } : null,
		artifacts: edition ? await listEditionArtifacts(db, edition.id) : [],
		exports: await listUserExports(db, locals.user!.id, { scope: 'story', targetId: story.id }),
		reviewInvitations,
		// For the Editor section: which keys this story overrides, and the
		// account values the inherit options fall back to.
		preferenceOverrides,
		accountPreferences,
		// Same shape for the Page setup section.
		pageSetupOverrides,
		accountPageSetup,
		// Whether to offer "Review this story" in the Review section.
		assistant,
		drafts
	};
};

export const actions: Actions = {
	requestExport: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		if (!exportLimit(locals.user!.id).allowed) {
			return fail(429, {
				action: 'export',
				message: 'Too many exports just now. Try again shortly.'
			});
		}
		const data = await request.formData();
		const format = String(data.get('format') ?? 'zip');
		if (format !== 'zip' && format !== 'epub') {
			return fail(400, { action: 'export', message: 'Choose a zip or an EPUB.' });
		}
		const result = await requestExport(db, locals.user!.id, {
			scope: 'story',
			targetId: story.id,
			format: format as ExportFormat
		});
		if (!result.ok) return fail(400, { action: 'export', message: result.reason });
		if (!(await queueUserExport(result.id))) {
			await markExportFailed(db, result.id, 'Could not start the export.');
			return fail(503, { action: 'export', message: 'Could not start the export. Try again.' });
		}
		return { action: 'export', queued: true };
	},
	update: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const title = formText(data, 'title').trim();
		const author = formText(data, 'author').trim() || null;
		const brief = formText(data, 'brief').trim() || null;
		const descriptionMd = formText(data, 'description').trim() || null;
		const styleNotes = formText(data, 'styleNotes').trim() || null;
		if (!title) {
			return fail(400, { action: 'update', message: 'The story needs a title.' });
		}
		// The colour field only shows while the story has no artwork; a form
		// without it leaves the stored colour alone.
		const coverColor = data.has('coverColor') ? data.get('coverColor') : story.coverColor;
		if (coverColor !== null && !isCoverColor(coverColor)) {
			return fail(400, { action: 'update', message: 'Pick a cover colour from the list.' });
		}
		const slug = await saveStoryDetails(db, locals.user!.id, story, {
			title,
			author,
			brief,
			descriptionMd,
			styleNotes,
			coverColor
		});
		// A changed slug moves this page's own URL.
		if (slug !== story.slug) redirect(303, `/stories/${slug}/settings`);
		return { action: 'update', saved: true };
	},
	saveGoals: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const rawTarget = formText(data, 'targetWords').trim();
		const rawDeadline = formText(data, 'deadline').trim();
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
		const mode = formText(data, 'entityAutocomplete');
		const marks = formText(data, 'continuousSceneMarks');
		const editing = formText(data, 'editingMode');
		const spell = formText(data, 'spellCheck');
		// The "browser" sentinel distinguishes an explicit follow-the-browser
		// override from inheriting the account language.
		const languageRaw = formText(data, 'writingLanguage');
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
			const value = formText(data, name);
			return value !== '' && value in table ? value : null;
		};
		const triState = (name: string) => {
			const value = formText(data, name);
			return value === 'on' ? true : value === 'off' ? false : null;
		};
		const fontSizeRaw = formText(data, 'fontSize');
		const fontSize = FONT_SIZES.includes(Number(fontSizeRaw) as (typeof FONT_SIZES)[number])
			? Number(fontSizeRaw)
			: null;
		const font = enumValue('font', PAGE_FONTS);
		const lineSpacing = enumValue('lineSpacing', LINE_SPACINGS);
		// The companion inputs only carry an override when their select selects
		// the custom option; otherwise they clear so the account value applies.
		const fontCustom = font === 'custom' ? formText(data, 'fontCustom').slice(0, 50) : null;
		const lineSpacingCmRaw = Number(data.get('lineSpacingCm'));
		const lineSpacingCm =
			lineSpacing === 'custom' &&
			Number.isFinite(lineSpacingCmRaw) &&
			lineSpacingCmRaw >= LINE_SPACING_CM_MIN &&
			lineSpacingCmRaw <= LINE_SPACING_CM_MAX
				? lineSpacingCmRaw
				: null;
		await saveStoryPageSetup(db, story.id, {
			pageSize: enumValue('pageSize', PAGE_SIZES),
			margins: enumValue('margins', PAGE_MARGINS),
			font,
			fontCustom,
			fontSize,
			paragraphStyle: enumValue('paragraphStyle', { indent: true, spaced: true }),
			lineSpacing,
			lineSpacingCm,
			textAlign: enumValue('textAlign', TEXT_ALIGNS),
			gutter: enumValue('gutter', GUTTERS),
			sceneBreak:
				formText(data, 'sceneBreakMode') === 'custom'
					? formText(data, 'sceneBreak').trim().slice(0, 20)
					: null,
			pageNumbers: triState('pageNumbers'),
			runningHeader: triState('runningHeader')
		});
		return { action: 'pagesetup', saved: true };
	},
	setVisibility: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const visibility = formText(data, 'visibility');
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
		const versionLabel = formText(data, 'versionLabel');
		const draftId = formText(data, 'draftId');
		if (draftId && !isUuid(draftId)) {
			return fail(400, { action: 'publish', message: 'That saved draft no longer exists.' });
		}
		// The first publish asks what name goes public; the chosen name rides
		// the form and lands as the pen name, unless one is already set.
		const penName = formText(data, 'penName');
		if (penName) await setPenNameIfUnset(db, locals.user!.id, penName);
		const result = await publishStory(db, locals.user!.id, story.id, versionLabel, draftId || null);
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
		const expiresRaw = formText(data, 'expiresDays').trim();
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
			email: formText(data, 'note'),
			canSuggest: data.get('canSuggest') === 'on',
			expiresAt: expiresDays > 0 ? new Date(Date.now() + expiresDays * 86_400_000) : null
		});
		// The raw token exists only in this response; the row keeps its hash.
		return { action: 'review', reviewLink: `/review/${token}` };
	},
	revokeReviewInvite: async ({ request, params, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const invitationId = formText(data, 'invitationId');
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
		if (!uploadLimit(locals.user!.id).allowed) {
			return fail(429, {
				action: 'cover',
				message: 'Too many uploads just now. Try again shortly.'
			});
		}
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
		// The replaced cover goes, unless a saved draft still shows it.
		const unused = await replaceCover(db, story.id, created.id);
		if (unused) await deleteAsset(db, locals.user!.id, unused);
		return { action: 'cover', saved: true };
	},
	saveDraft: async ({ request, params, locals }) => {
		rateLimitWrites(locals.user!.id);
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const label = formText(data, 'label');
		const note = formText(data, 'note');
		const result = await saveDraft(db, locals.user!.id, story.id, { label, note });
		// The typed name and note come back, so a failed save loses neither.
		if (!result.ok) return fail(400, { action: 'drafts', message: result.reason, label, note });
		return { action: 'drafts', savedDraftId: result.id };
	},
	updateDraft: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const draftId = formText(data, 'draftId');
		if (!isUuid(draftId)) {
			return fail(400, { action: 'drafts', message: 'That saved draft no longer exists.' });
		}
		const result = await updateDraftDetails(db, story.id, draftId, {
			label: formText(data, 'label'),
			note: formText(data, 'note')
		});
		if (!result.ok) return fail(400, { action: 'drafts', draftId, message: result.reason });
		return { action: 'drafts', draftId, saved: true };
	},
	deleteDraft: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const draftId = formText(await request.formData(), 'draftId');
		if (!isUuid(draftId)) {
			return fail(400, { action: 'drafts', message: 'That saved draft no longer exists.' });
		}
		const result = await deleteDraft(db, locals.user!.id, story.id, draftId);
		if (!result.ok) return fail(400, { action: 'drafts', message: result.reason });
		return { action: 'drafts', deleted: true };
	},
	delete: async ({ params, locals }) => {
		const { story, universe } = await ownedStory(params.id, locals.user!.id);
		await trashStory(db, locals.user!.id, story.id);
		redirect(303, `/universes/${universe.slug}`);
	}
};
