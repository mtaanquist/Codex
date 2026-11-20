import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { chapters } from '#lib/server/db/schema';
import { ownedStory } from '#lib/server/story-access';
import {
	findInStory,
	MAX_MATCHES,
	replaceInStory,
	type ReplaceScope,
	type SceneReplacement
} from '#lib/server/story-replace';
import { readJson } from '#lib/server/validation';
import { rateLimitWrites } from '#lib/server/write-guard';
import { isUuid } from '#lib/slug';

// Find and replace across a chapter or the whole story: GET lists the matches,
// POST replaces the ones the writer kept.

const TERM_MAX = 500;

async function scopeFor(storyId: string, chapterId: unknown): Promise<ReplaceScope> {
	if (chapterId === null || chapterId === undefined || chapterId === '')
		return { storyId, chapterId: null };
	if (typeof chapterId !== 'string' || !isUuid(chapterId)) error(400, 'chapter is not valid');
	const [chapter] = await db
		.select({ id: chapters.id })
		.from(chapters)
		.where(and(eq(chapters.id, chapterId), eq(chapters.storyId, storyId)));
	if (!chapter) error(404, 'Chapter not found');
	return { storyId, chapterId: chapter.id };
}

// The search text as typed: spaces count, so it is not trimmed.
function findTerm(value: unknown): string {
	if (typeof value !== 'string' || value === '' || value.length > TERM_MAX)
		error(400, 'Enter the text to find');
	return value;
}

export const GET: RequestHandler = async ({ params, url, locals }) => {
	const { story } = await ownedStory(params.id, locals.user!.id);
	const scope = await scopeFor(story.id, url.searchParams.get('chapter'));
	const find = findTerm(url.searchParams.get('q'));
	const options = {
		matchCase: url.searchParams.get('case') === '1',
		wholeWord: url.searchParams.get('word') === '1'
	};
	return Response.json(await findInStory(db, scope, find, options));
};

function sceneList(value: unknown): SceneReplacement[] {
	if (!Array.isArray(value)) error(400, 'scenes must be a list');
	let total = 0;
	const out: SceneReplacement[] = [];
	const seen = new Set<string>();
	for (const item of value as unknown[]) {
		const entry = item as { sceneId?: unknown; baseHash?: unknown; starts?: unknown };
		if (
			typeof entry?.sceneId !== 'string' ||
			!isUuid(entry.sceneId) ||
			seen.has(entry.sceneId) ||
			typeof entry.baseHash !== 'string' ||
			!Array.isArray(entry.starts) ||
			!entry.starts.every((start) => Number.isInteger(start) && start >= 0)
		)
			error(400, 'scenes is not valid');
		seen.add(entry.sceneId);
		total += entry.starts.length;
		if (total > MAX_MATCHES) error(400, 'Too many matches at once');
		out.push({ sceneId: entry.sceneId, baseHash: entry.baseHash, starts: entry.starts });
	}
	return out;
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const { story } = await ownedStory(params.id, locals.user!.id);
	const payload = await readJson<{
		chapterId?: unknown;
		find?: unknown;
		replace?: unknown;
		matchCase?: unknown;
		wholeWord?: unknown;
		scenes?: unknown;
	}>(request);
	const scope = await scopeFor(story.id, payload.chapterId);
	const find = findTerm(payload.find);
	if (typeof payload.replace !== 'string' || payload.replace.length > TERM_MAX)
		error(400, 'replace is not valid');
	const options = { matchCase: payload.matchCase === true, wholeWord: payload.wholeWord === true };
	if (options.matchCase && payload.replace === find) error(400, 'find and replace are the same');
	const scenes = sceneList(payload.scenes);
	return Response.json(
		await replaceInStory(db, scope, { find, replace: payload.replace, options, scenes })
	);
};
