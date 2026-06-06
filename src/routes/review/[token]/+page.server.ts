import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { stories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	addComment,
	createSuggestion,
	createThread,
	ensureReviewer,
	invitationByToken,
	issueReviewerToken,
	listSuggestions,
	listThreads,
	readReviewerToken,
	reviewerAccess,
	REVIEWER_COOKIE
} from '$lib/server/review';
import { gatherStory } from '$lib/server/export';
import { reanchorRange } from '$lib/review-anchor';
import { rateLimit } from '$lib/server/rate-limit';
import { notifyReviewActivity } from '$lib/server/notify';

// The guest's door into a review: the magic link. A bad, revoked, or expired
// link gets a plain message; a fresh guest is asked for a name; after that
// the manuscript renders read-only with the comment threads.

const COMMENT_LIMIT = 30;
const COMMENT_WINDOW_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cookieOptions = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax' as const,
	maxAge: 30 * 24 * 60 * 60
};

// The reviewer for this request, when the cookie holds one with live access
// to the invitation's story.
async function currentReviewer(token: string, cookieValue: string | undefined) {
	const resolved = await invitationByToken(db, token);
	if (resolved.status !== 'ok') return { resolved, access: null };
	const reviewerId = readReviewerToken(cookieValue);
	if (!reviewerId) return { resolved, access: null };
	const access = await reviewerAccess(db, reviewerId, resolved.invitation.storyId);
	return { resolved, access };
}

export const load: PageServerLoad = async ({ params, cookies, locals }) => {
	const { resolved, access } = await currentReviewer(params.token, cookies.get(REVIEWER_COOKIE));
	if (resolved.status !== 'ok') {
		return { state: resolved.status };
	}

	let reviewer = access?.reviewer ?? null;
	// A signed-in user joins under their own name without a form.
	if (!reviewer && locals.user) {
		reviewer = await ensureReviewer(db, resolved.invitation.id, {
			userId: locals.user.id,
			displayName: locals.user.displayName
		});
		if (reviewer) cookies.set(REVIEWER_COOKIE, issueReviewerToken(reviewer.id), cookieOptions);
	}
	if (!reviewer) {
		return { state: 'join' as const, storyTitle: resolved.storyTitle };
	}

	const storyId = resolved.invitation.storyId;
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
	const content = await gatherStory(db, story);
	return {
		state: 'review' as const,
		storyTitle: resolved.storyTitle,
		reviewerName: reviewer.displayName,
		canSuggest: resolved.invitation.canSuggest,
		chapters: content.chapters,
		scenes: content.scenes.map((scene) => ({
			id: scene.id!,
			chapterId: scene.chapterId,
			title: scene.title,
			bodyMd: scene.bodyMd
		})),
		threads: await listThreads(db, storyId, reanchorRange),
		suggestions: await listSuggestions(db, storyId)
	};
};

export const actions: Actions = {
	join: async ({ params, request, cookies }) => {
		const resolved = await invitationByToken(db, params.token);
		if (resolved.status !== 'ok') return fail(403, { message: 'This link no longer works.' });
		const data = await request.formData();
		const reviewer = await ensureReviewer(db, resolved.invitation.id, {
			displayName: String(data.get('displayName') ?? '')
		});
		if (!reviewer) return fail(400, { message: 'Enter a name to review under.' });
		cookies.set(REVIEWER_COOKIE, issueReviewerToken(reviewer.id), cookieOptions);
		return { joined: true };
	},
	comment: async ({ params, request, cookies }) => {
		const { resolved, access } = await currentReviewer(params.token, cookies.get(REVIEWER_COOKIE));
		if (resolved.status !== 'ok' || !access) {
			return fail(403, { message: 'This link no longer works.' });
		}
		if (!rateLimit(`review:${access.reviewer.id}`, COMMENT_LIMIT, COMMENT_WINDOW_MS).allowed) {
			return fail(429, { message: 'Slow down a moment, then try again.' });
		}
		const data = await request.formData();
		const start = Number(data.get('start'));
		const end = Number(data.get('end'));
		const anchor =
			Number.isInteger(start) && Number.isInteger(end) && end > start && start >= 0
				? { start, end }
				: null;
		const sceneId = String(data.get('sceneId') ?? '');
		if (!UUID.test(sceneId)) return fail(400, { message: 'That scene does not exist.' });
		const result = await createThread(db, {
			storyId: resolved.invitation.storyId,
			sceneId,
			anchor,
			author: { reviewerId: access.reviewer.id },
			body: String(data.get('body') ?? '')
		});
		if (!result.ok) return fail(400, { message: result.reason });
		await notifyReviewActivity(
			db,
			resolved.invitation.storyId,
			access.reviewer.displayName,
			'commented',
			String(data.get('body') ?? '')
		);
		return { commented: true };
	},
	suggest: async ({ params, request, cookies }) => {
		const { resolved, access } = await currentReviewer(params.token, cookies.get(REVIEWER_COOKIE));
		if (resolved.status !== 'ok' || !access) {
			return fail(403, { message: 'This link no longer works.' });
		}
		if (!access.invitation.canSuggest) {
			return fail(403, { message: 'This review link is for comments only.' });
		}
		if (!rateLimit(`review:${access.reviewer.id}`, COMMENT_LIMIT, COMMENT_WINDOW_MS).allowed) {
			return fail(429, { message: 'Slow down a moment, then try again.' });
		}
		const data = await request.formData();
		const sceneId = String(data.get('sceneId') ?? '');
		if (!UUID.test(sceneId)) return fail(400, { message: 'That scene does not exist.' });
		const result = await createSuggestion(db, {
			storyId: resolved.invitation.storyId,
			sceneId,
			reviewerId: access.reviewer.id,
			range: { start: Number(data.get('start')), end: Number(data.get('end')) },
			replacement: String(data.get('replacement') ?? '')
		});
		if (!result.ok) return fail(400, { message: result.reason });
		await notifyReviewActivity(
			db,
			resolved.invitation.storyId,
			access.reviewer.displayName,
			'suggested an edit'
		);
		return { suggested: true };
	},
	reply: async ({ params, request, cookies }) => {
		const { resolved, access } = await currentReviewer(params.token, cookies.get(REVIEWER_COOKIE));
		if (resolved.status !== 'ok' || !access) {
			return fail(403, { message: 'This link no longer works.' });
		}
		if (!rateLimit(`review:${access.reviewer.id}`, COMMENT_LIMIT, COMMENT_WINDOW_MS).allowed) {
			return fail(429, { message: 'Slow down a moment, then try again.' });
		}
		const data = await request.formData();
		const threadId = String(data.get('threadId') ?? '');
		if (!UUID.test(threadId)) return fail(400, { message: 'That thread does not exist.' });
		const result = await addComment(db, {
			storyId: resolved.invitation.storyId,
			threadId,
			author: { reviewerId: access.reviewer.id },
			body: String(data.get('body') ?? '')
		});
		if (!result.ok) return fail(400, { message: result.reason });
		await notifyReviewActivity(
			db,
			resolved.invitation.storyId,
			access.reviewer.displayName,
			'replied',
			String(data.get('body') ?? '')
		);
		return { commented: true };
	}
};
