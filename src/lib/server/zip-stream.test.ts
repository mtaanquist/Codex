import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { uploadZip, zipBytes, zipChunks, type ZipEntry } from './zip-stream';

async function* chunks(...parts: string[]) {
	for (const part of parts) yield strToU8(part);
}

describe('zipChunks', () => {
	it('writes in-memory and streamed entries that unzip back to the same content', async () => {
		const bytes = await zipBytes([
			{ path: 'mimetype', data: strToU8('application/epub+zip'), stored: true },
			{ path: 'a/story.md', data: strToU8('# Title\n') },
			{ path: 'assets/x.png', data: async () => chunks('one', 'two', 'three'), stored: true }
		]);
		const entries = unzipSync(bytes);
		expect(Object.keys(entries)).toEqual(['mimetype', 'a/story.md', 'assets/x.png']);
		expect(strFromU8(entries['a/story.md'])).toBe('# Title\n');
		expect(strFromU8(entries['assets/x.png'])).toBe('onetwothree');
		// EPUB readers look for the uncompressed mimetype right after the
		// first local header (30 bytes plus the 8-byte name).
		expect(strFromU8(bytes.subarray(38, 58))).toBe('application/epub+zip');
	});

	it('opens a streamed entry only when its turn comes', async () => {
		const opened: string[] = [];
		const lazy = (name: string): ZipEntry => ({
			path: name,
			data: async () => {
				opened.push(name);
				return chunks(name);
			}
		});
		const stream = zipChunks([lazy('a'), lazy('b'), lazy('c')]);
		await stream.next();
		expect(opened).toEqual(['a']);
		for await (const chunk of stream) void chunk;
		expect(opened).toEqual(['a', 'b', 'c']);
	});

	it('writes an empty archive', async () => {
		expect(Object.keys(unzipSync(await zipBytes([])))).toEqual([]);
	});
});

describe('uploadZip', () => {
	it('streams the archive to the store and returns its size', async () => {
		let received: Buffer | null = null;
		let type = '';
		const size = await uploadZip(
			{
				async upload(_key, body: Readable, contentType) {
					const parts: Buffer[] = [];
					for await (const chunk of body) parts.push(Buffer.from(chunk));
					received = Buffer.concat(parts);
					type = contentType;
				}
			},
			'k',
			[{ path: 'x.md', data: strToU8('hello') }],
			'application/zip'
		);
		expect(type).toBe('application/zip');
		expect(received!.byteLength).toBe(size);
		expect(strFromU8(unzipSync(new Uint8Array(received!))['x.md'])).toBe('hello');
	});
});
