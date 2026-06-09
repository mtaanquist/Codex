import { describe, it, expect } from 'vitest';
import { buildRecapMessage } from './recap';

describe('buildRecapMessage', () => {
	it('names the scene the recap runs through when given a title', () => {
		const message = buildRecapMessage('The river crossing');
		expect(message).toContain('The river crossing');
		expect(message).toMatch(/recap/i);
	});

	it('falls back to "so far" with no scene title', () => {
		expect(buildRecapMessage(null)).toMatch(/so far/i);
		expect(buildRecapMessage('   ')).toMatch(/so far/i);
	});

	it('steers away from continuing the story', () => {
		const message = buildRecapMessage('A scene');
		expect(message).toMatch(/do not continue|do not.*invent/i);
	});
});
