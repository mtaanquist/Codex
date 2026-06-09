import { describe, it, expect } from 'vitest';
import { buildSceneSummaryMessage, buildChapterSummaryMessage } from './summary';

describe('buildSceneSummaryMessage', () => {
	it('names the scene and includes its prose, asking for only the summary', () => {
		const body = 'Alice crossed the river at dusk and lost her pack to the current.';
		const message = buildSceneSummaryMessage('The Crossing', body);
		expect(message).toContain('The Crossing');
		expect(message).toContain(body);
		expect(message).toMatch(/only the summary/i);
		expect(message).toMatch(/one or two sentences/i);
	});

	it('falls back to "this scene" with no title', () => {
		expect(buildSceneSummaryMessage(null, 'Some prose.')).toMatch(/this scene/i);
	});
});

describe('buildChapterSummaryMessage', () => {
	it('names the chapter and lists the scene summaries it draws on', () => {
		const message = buildChapterSummaryMessage('Descent', [
			'They go under.',
			'They find the bell.'
		]);
		expect(message).toContain('Descent');
		expect(message).toContain('They go under.');
		expect(message).toContain('They find the bell.');
		expect(message).toMatch(/only the summary/i);
	});
});
