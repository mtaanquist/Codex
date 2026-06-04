import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { publicEdition, type EditionContent } from '$lib/server/publish';

// The reader view of one frozen edition. Adult work sits behind a
// confirmation link; the page then carries noindex either way.
export const load: PageServerLoad = async ({ params, url }) => {
	const edition = await publicEdition(db, params.handle, params.story);
	if (!edition) error(404, 'Not found');

	const confirmed = url.searchParams.get('adult') === 'ok';
	if (edition.isAdult && !confirmed) {
		return {
			handle: params.handle,
			storyId: params.story,
			gate: true as const,
			title: edition.title,
			author: edition.author
		};
	}
	return {
		handle: params.handle,
		storyId: params.story,
		gate: false as const,
		title: edition.title,
		author: edition.author,
		descriptionMd: edition.descriptionMd,
		isAdult: edition.isAdult,
		versionLabel: edition.versionLabel,
		publishedAt: edition.publishedAt,
		coverAssetId: edition.coverAssetId,
		content: edition.content as EditionContent
	};
};
