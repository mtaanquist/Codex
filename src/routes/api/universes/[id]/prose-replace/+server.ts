import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ownedUniverse } from '$lib/server/universe-access';
import { countProseMatches, replaceProse } from '$lib/server/prose-replace';

// The rename sweep behind the entity editor's offer: GET counts what a
// replacement would touch, POST performs it.

const NAME_MAX = 200;

function cleanTerm(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const term = value.trim();
	if (term === '' || term.length > NAME_MAX) return null;
	return term;
}

export const GET: RequestHandler = async ({ params, url, locals }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	const find = cleanTerm(url.searchParams.get('q'));
	if (!find) error(400, 'q must be a non-empty name');
	return json(await countProseMatches(db, universe.id, find));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	const payload = (await request.json()) as { find?: unknown; replace?: unknown };
	const find = cleanTerm(payload.find);
	const replace = cleanTerm(payload.replace);
	if (!find || !replace) error(400, 'find and replace must be non-empty names');
	if (find === replace) error(400, 'find and replace are the same');
	return json(await replaceProse(db, universe.id, find, replace));
};
