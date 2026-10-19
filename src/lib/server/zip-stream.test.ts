import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { uploadZip, zipBytes, zipChunks, type ZipEntry } from './zip-stream';

async function* chunks(...parts: string[]) {
	for (const part of parts) yield strToU8(part);
}

type Header = {
	name: string;
	flag: number;
	method: number;
	crc: number;
	compressed: number;
	size: number;
	extra: number;
};

// Every entry's local header, found through the central directory.
function localHeaders(zip: Uint8Array): Header[] {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const end = zip.byteLength - 22;
	expect(view.getUint32(end, true)).toBe(0x06054b50);
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const headers: Header[] = [];
	for (let i = 0; i < count; i++) {
		expect(view.getUint32(at, true)).toBe(0x02014b50);
		const nameLength = view.getUint16(at + 28, true);
		const local = view.getUint32(at + 42, true);
		expect(view.getUint32(local, true)).toBe(0x04034b50);
		const localName = view.getUint16(local + 26, true);
		headers.push({
			name: strFromU8(zip.subarray(local + 30, local + 30 + localName)),
			flag: view.getUint16(local + 6, true),
			method: view.getUint16(local + 8, true),
			crc: view.getUint32(local + 14, true),
			compressed: view.getUint32(local + 18, true),
			size: view.getUint32(local + 22, true),
			extra: view.getUint16(local + 28, true)
		});
		at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
	}
	return headers;
}

describe('zipChunks', () => {
	// Streaming readers (Java's ZipInputStream) refuse a stored entry whose
	// sizes follow its data, and EPUB readers want the mimetype header whole.
	it('never marks a stored entry as having its sizes after the data', async () => {
		const zip = await zipBytes([
			{ path: 'mimetype', data: strToU8('application/epub+zip'), stored: true },
			{ path: 'OEBPS/ch1.xhtml', data: strToU8('<p>Hi</p>') },
			{ path: 'OEBPS/images/a.png', data: async () => chunks('png bytes') }
		]);
		const headers = localHeaders(zip);
		expect(headers.map((h) => h.name)).toEqual([
			'mimetype',
			'OEBPS/ch1.xhtml',
			'OEBPS/images/a.png'
		]);
		for (const header of headers) {
			if (header.method === 0) expect(header.flag & 0x8).toBe(0);
		}
		expect(headers[0]).toEqual({
			name: 'mimetype',
			flag: 0,
			method: 0,
			crc: crc32('application/epub+zip'),
			compressed: 20,
			size: 20,
			extra: 0
		});
		// The streamed image is deflated, the one kind allowed trailing sizes.
		expect(headers[2]).toMatchObject({ method: 8, flag: 0x8 });
		expect(strFromU8(unzipSync(zip)['OEBPS/images/a.png'])).toBe('png bytes');
	});

	it('releases an open source when the reader stops early', async () => {
		let released = false;
		async function* image() {
			try {
				for (let i = 0; i < 100; i++) yield new Uint8Array(64 * 1024);
			} finally {
				released = true;
			}
		}
		const body = Readable.from(zipChunks([{ path: 'a.png', data: async () => image() }]));
		let read = 0;
		for await (const chunk of body) {
			void chunk;
			if (++read === 3) break;
		}
		// Destroying the stream returns the generator on a later tick.
		await new Promise((resolve) => setImmediate(resolve));
		expect(read).toBe(3);
		expect(released).toBe(true);
	});

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
		// The first local header goes out before its source is opened.
		await stream.next();
		expect(opened).toEqual([]);
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
