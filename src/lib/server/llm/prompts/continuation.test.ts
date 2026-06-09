import { describe, it, expect } from 'vitest';
import { buildContinuationMessage } from './continuation';

describe('buildContinuationMessage', () => {
	it('asks for a bare continuation and includes the preceding prose', () => {
		const before = 'The gate of Halden opened the way it always did.';
		const message = buildContinuationMessage(before);
		expect(message).toContain(before);
		expect(message).toMatch(/continuation/i);
		// It must steer away from preamble and repetition.
		expect(message).toMatch(/only the continuation/i);
		expect(message).toMatch(/do not repeat/i);
	});
});
