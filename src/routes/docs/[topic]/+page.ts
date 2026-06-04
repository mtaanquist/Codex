import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { docArticle, docTopics } from '$lib/docs';

export const load: PageLoad = ({ params }) => {
	const article = docArticle(params.topic);
	if (!article) error(404, 'Help topic not found');
	return { article, topics: docTopics() };
};
