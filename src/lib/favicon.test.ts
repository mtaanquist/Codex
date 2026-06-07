import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { faviconDataUrl, faviconSvg } from './favicon.ts';
import { DEFAULT_ACCENT } from './appearance.ts';

describe('faviconSvg', () => {
	it('paints the gradient from the accent to its darkened stop', () => {
		const svg = faviconSvg('#2fae8c');
		expect(svg).toContain('stop-color="#2fae8c"');
		// Each channel scaled by 0.55: 2f->1a, ae->60, 8c->4d.
		expect(svg).toContain('stop-color="#1a604d"');
	});

	it('falls back to the default accent for anything that is not a colour', () => {
		expect(faviconSvg('javascript:alert(1)')).toContain(`stop-color="${DEFAULT_ACCENT}"`);
	});

	it('expands three-digit accents like the rest of the app', () => {
		expect(faviconSvg('#abc')).toContain('stop-color="#aabbcc"');
	});

	it('builds a data URL the link tag can take directly', () => {
		const url = faviconDataUrl('#5b8cff');
		expect(url.startsWith('data:image/svg+xml,')).toBe(true);
		expect(decodeURIComponent(url.slice('data:image/svg+xml,'.length))).toBe(faviconSvg('#5b8cff'));
	});

	it('matches the static asset, so the default favicon cannot drift', () => {
		const asset = readFileSync(new URL('./assets/favicon.svg', import.meta.url), 'utf8');
		expect(asset.trim()).toBe(faviconSvg(DEFAULT_ACCENT));
	});
});
