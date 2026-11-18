import { describe, it, expect } from 'vitest';
import { PLAIN_TEXT_FORMAT, PROSE_FORMAT } from './format';
import { buildCoauthorMessage } from './coauthor';
import { buildContinuationMessage } from './continuation';
import { buildChapterSummaryMessage, buildSceneSummaryMessage } from './summary';
import { buildEnrichMessage } from './enrich';

// Replies that land in a scene or an entity field must not carry chat-style
// Markdown, so each of those prompts says so.
describe('output format guidance', () => {
	it('asks for manuscript prose where the reply goes into a scene', () => {
		expect(buildCoauthorMessage('a paragraph')).toContain(PROSE_FORMAT);
		expect(buildContinuationMessage('The rain fell.')).toContain(PROSE_FORMAT);
	});

	it('asks for plain text where the reply becomes a summary or entity field', () => {
		expect(buildSceneSummaryMessage('Gate', 'The rain fell.')).toContain(PLAIN_TEXT_FORMAT);
		expect(buildChapterSummaryMessage('One', ['The rain fell.'])).toContain(PLAIN_TEXT_FORMAT);
		expect(
			buildEnrichMessage(
				{
					kind: 'character',
					name: 'Ada',
					aliases: [],
					details: [],
					summaryMd: null,
					hasSummary: false
				},
				[]
			)
		).toContain(PLAIN_TEXT_FORMAT);
	});
});
