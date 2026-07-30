import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { publicEdition, type EditionContent } from '$lib/server/publish';
import { listEditionArtifacts } from '$lib/server/export-artifacts';
import { authorName } from '$lib/author-name';
import { wordCount } from '$lib/word-count';

// The reader view of one frozen edition. Adult work sits behind a
// confirmation link; the page then carries noindex either way.
export const load: PageServerLoad = async ({ params, url }) => {
	const handle = params.handle.toLowerCase();
	const edition = await publicEdition(db, handle, params.story);
	if (!edition) error(404, 'Not found');

	// The reader chrome names the author: their own credit on the story if they
	// gave one, else the name on their account. Never the raw handle.
	const author = edition.author?.trim() || authorName(edition);

	const confirmed = url.searchParams.get('adult') === 'ok';
	if (edition.isAdult && !confirmed) {
		return {
			handle,
			storyId: params.story,
			gate: true as const,
			title: edition.title,
			author
		};
	}
	// Reader-facing downloads, only when the author switched them on. The
	// markdown zip is owner-only and never offered here.
	const downloads = edition.downloadsPublic
		? (await listEditionArtifacts(db, edition.id))
				.filter((artifact) => artifact.format !== 'markdown')
				.map((artifact) => ({ id: artifact.id, format: artifact.format }))
		: [];

	const content = edition.content as EditionContent;
	// The byline's word count, taken from the frozen prose so it matches what is
	// on the page rather than the live draft.
	const words =
		content.chapters.reduce(
			(sum, chapter) =>
				sum + chapter.scenes.reduce((chapterSum, scene) => chapterSum + wordCount(scene.bodyMd), 0),
			0
		) + content.unfiled.reduce((sum, scene) => sum + wordCount(scene.bodyMd), 0);

	return {
		handle,
		storyId: params.story,
		gate: false as const,
		title: edition.title,
		author,
		words,
		descriptionMd: edition.descriptionMd,
		isAdult: edition.isAdult,
		versionLabel: edition.versionLabel,
		publishedAt: edition.publishedAt,
		coverAssetId: edition.coverAssetId,
		downloads,
		content
	};
};
