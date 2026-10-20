import { describe, it, expect } from 'vitest';
import { parseAo3Bodies } from './import-ao3';

describe('parseAo3Bodies', () => {
	it('returns null for markup that is not an AO3 download', () => {
		expect(parseAo3Bodies(['<h1>Title</h1><p>Prose.</p>'])).toBeNull();
	});

	// An unterminated tag used to make every later match scan to the end of the
	// input, which is quadratic in the file size.
	it('reads a run of unterminated tags in linear time', () => {
		for (const junk of ['<a'.repeat(200_000), '<a "'.repeat(100_000)]) {
			const started = Date.now();
			parseAo3Bodies([`<div id="chapters"><div><p>${junk}</p></div></div>`, junk]);
			expect(Date.now() - started).toBeLessThan(2000);
		}
	});
});
