import { describe, it, expect } from 'vitest';
import { docArticle, docTopics } from './docs';

describe('docTopics', () => {
	it('lists the registered topics with a title and summary each', () => {
		const topics = docTopics();
		expect(topics.map((t) => t.slug)).toEqual([
			'getting-started',
			'editor',
			'planning',
			'publishing',
			'reviewing',
			'account',
			'security',
			'shortcuts'
		]);
		for (const topic of topics) {
			// Title comes from the article's heading, so a missing file shows here.
			expect(topic.title).not.toBe('Help');
			expect(topic.title.length).toBeGreaterThan(0);
			expect(topic.summary.length).toBeGreaterThan(0);
		}
	});
});

describe('docArticle', () => {
	it('returns each registered article with its heading as the title', () => {
		for (const topic of docTopics()) {
			const article = docArticle(topic.slug);
			expect(article).not.toBeNull();
			expect(article!.title).toBe(topic.title);
			expect(article!.body).toContain('# ');
		}
	});

	it('returns null for an unknown topic', () => {
		expect(docArticle('does-not-exist')).toBeNull();
		expect(docArticle('../secret')).toBeNull();
	});
});
