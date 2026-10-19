import { describe, expect, it } from 'vitest';
import { formText } from './validation';

describe('formText', () => {
	it('returns the field value, or an empty string when it is missing', () => {
		const data = new FormData();
		data.set('title', 'The Long Road');
		expect(formText(data, 'title')).toBe('The Long Road');
		expect(formText(data, 'missing')).toBe('');
	});
});
