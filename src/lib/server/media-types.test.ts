import { describe, it, expect } from 'vitest';
import { sniffImageType } from './media-types';

describe('sniffImageType', () => {
	it('detects each accepted image type from its magic bytes', () => {
		expect(sniffImageType(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe('image/png');
		expect(sniffImageType(Buffer.from('ffd8ffe000104a46', 'hex'))).toBe('image/jpeg');
		expect(sniffImageType(Buffer.from('474946383961', 'hex'))).toBe('image/gif');
		// "RIFF" + 4 size bytes + "WEBP"
		expect(sniffImageType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary'))).toBe(
			'image/webp'
		);
		// ISO box: 4 size bytes + "ftyp" + "avif"
		expect(sniffImageType(Buffer.from('\x00\x00\x00\x18ftypavif', 'binary'))).toBe('image/avif');
	});

	it('returns null for non-image and too-short bytes', () => {
		expect(sniffImageType(Buffer.from('this is not an image'))).toBeNull();
		expect(sniffImageType(Buffer.from('GIF', 'ascii'))).toBeNull();
		expect(sniffImageType(Buffer.alloc(0))).toBeNull();
		// A RIFF container that is not WEBP (e.g. a WAV) is refused.
		expect(sniffImageType(Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'binary'))).toBeNull();
	});
});
