import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { Deflate, deflateSync, strToU8 } from 'fflate';
import type { AssetObjectStore } from './assets.ts';

// Exports and edition files are written as a stream: entries go into the zip
// one at a time and the output flows straight to the bucket, so neither the
// finished archive nor every bundled image sits in memory at once. Runs in the
// worker, so relative value imports carry explicit .ts extensions.
//
// The zip records are written here rather than by fflate's streaming Zip,
// which marks every entry as "sizes follow the data", stored ones included.
// Streaming readers (Java's ZipInputStream, some EPUB readers) refuse a stored
// entry marked that way. Entries in hand get real sizes up front; a streamed
// entry is deflated (at level 0 for images, which are compressed already),
// the one kind allowed to carry its sizes after the data.

// An entry's content: bytes already in hand (prose), or a function that opens
// a stream (a bundled image read from the bucket), called only when the entry
// is written.
export type ZipSource = Uint8Array | (() => Promise<AsyncIterable<Uint8Array>>);
// `stored` skips compression for an entry in hand: the EPUB mimetype, which
// the spec requires uncompressed. Streamed entries are always deflated.
export type ZipEntry =
	| { path: string; data: Uint8Array; stored?: boolean }
	| { path: string; data: () => Promise<AsyncIterable<Uint8Array>> };
export type ZipArchive = { filename: string; entries: ZipEntry[] };

export function textEntry(path: string, text: string): ZipEntry {
	return { path, data: strToU8(text) };
}

// A bundled image, read from its source only when the zip reaches it.
export function assetEntry(
	path: string,
	asset: { open(): Promise<AsyncIterable<Uint8Array>> }
): ZipEntry {
	return { path, data: () => asset.open() };
}

const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
// No Zip64: a count of 0xffff or a size or offset of 0xffffffff means "see the
// Zip64 record", so the export fails at those values rather than writing a
// broken file. Checking every offset covers the sizes too: a streamed entry is
// stored-deflate, so neither of its sizes can pass the offset after it, and
// prose held in memory is far below 4 GB. Overridable so the boundary is
// testable without 4 GB.
export const ZIP_LIMITS = { entries: 0xffff, bytes: 0xffffffff };

type EntryRecord = {
	name: Uint8Array;
	flag: number;
	method: 0 | 8;
	crc: number;
	compressed: number;
	size: number;
	offset: number;
};

// A fixed-size little-endian record, optionally followed by a file name.
function record(length: number, fill: (view: DataView) => void, name?: Uint8Array): Uint8Array {
	const out = new Uint8Array(length + (name?.byteLength ?? 0));
	fill(new DataView(out.buffer));
	if (name) out.set(name, length);
	return out;
}

function dosTime(date: Date): { time: number; day: number } {
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
	};
}

export async function* zipChunks(
	entries: Iterable<ZipEntry>,
	limits = ZIP_LIMITS
): AsyncGenerator<Uint8Array> {
	const { time, day } = dosTime(new Date());
	const written: EntryRecord[] = [];
	let offset = 0;
	const emit = (chunk: Uint8Array) => {
		offset += chunk.byteLength;
		if (offset >= limits.bytes) throw new Error('the export is too large for a zip file');
		return chunk;
	};
	// With the descriptor flag set, the CRC and sizes here are zero and follow
	// the data instead.
	const localHeader = (r: EntryRecord) =>
		record(
			30,
			(v) => {
				v.setUint32(0, 0x04034b50, true);
				v.setUint16(4, 20, true);
				v.setUint16(6, r.flag, true);
				v.setUint16(8, r.method, true);
				v.setUint16(10, time, true);
				v.setUint16(12, day, true);
				v.setUint32(14, r.crc, true);
				v.setUint32(18, r.compressed, true);
				v.setUint32(22, r.size, true);
				v.setUint16(26, r.name.byteLength, true);
			},
			r.name
		);

	for (const entry of entries) {
		if (written.length + 1 >= limits.entries) throw new Error('the export has too many files');
		const name = strToU8(entry.path);
		const flag = name.byteLength === entry.path.length ? 0 : FLAG_UTF8;

		if (entry.data instanceof Uint8Array) {
			const stored = 'stored' in entry && entry.stored === true;
			const body = stored ? entry.data : deflateSync(entry.data, { level: 6 });
			const r: EntryRecord = {
				name,
				flag,
				method: stored ? 0 : 8,
				crc: crc32(entry.data),
				compressed: body.byteLength,
				size: entry.data.byteLength,
				offset
			};
			yield emit(localHeader(r));
			yield emit(body);
			written.push(r);
			continue;
		}

		const r: EntryRecord = {
			name,
			flag: flag | FLAG_DESCRIPTOR,
			method: 8,
			crc: 0,
			compressed: 0,
			size: 0,
			offset
		};
		yield emit(localHeader(r));
		// fflate's Deflate is synchronous, so its output is ready as soon as a
		// push returns; handing it on after every push keeps one chunk in memory.
		const out: Uint8Array[] = [];
		const deflate = new Deflate({ level: 0 }, (chunk) => out.push(chunk));
		const drain = function* () {
			while (out.length > 0) {
				const chunk = out.shift()!;
				r.compressed += chunk.byteLength;
				yield emit(chunk);
			}
		};
		for await (const chunk of await entry.data()) {
			r.crc = crc32(chunk, r.crc);
			r.size += chunk.byteLength;
			deflate.push(chunk);
			yield* drain();
		}
		deflate.push(new Uint8Array(0), true);
		yield* drain();
		yield emit(
			record(16, (v) => {
				v.setUint32(0, 0x08074b50, true);
				v.setUint32(4, r.crc, true);
				v.setUint32(8, r.compressed, true);
				v.setUint32(12, r.size, true);
			})
		);
		written.push(r);
	}

	const directoryStart = offset;
	for (const r of written) {
		yield emit(
			record(
				46,
				(v) => {
					v.setUint32(0, 0x02014b50, true);
					v.setUint16(4, 20, true);
					v.setUint16(6, 20, true);
					v.setUint16(8, r.flag, true);
					v.setUint16(10, r.method, true);
					v.setUint16(12, time, true);
					v.setUint16(14, day, true);
					v.setUint32(16, r.crc, true);
					v.setUint32(20, r.compressed, true);
					v.setUint32(24, r.size, true);
					v.setUint16(28, r.name.byteLength, true);
					v.setUint32(42, r.offset, true);
				},
				r.name
			)
		);
	}
	const directorySize = offset - directoryStart;
	yield emit(
		record(22, (v) => {
			v.setUint32(0, 0x06054b50, true);
			v.setUint16(8, written.length, true);
			v.setUint16(10, written.length, true);
			v.setUint32(12, directorySize, true);
			v.setUint32(16, directoryStart, true);
		})
	);
}

// The whole archive as bytes, for tests and callers that need it in hand.
export async function zipBytes(entries: Iterable<ZipEntry>): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const chunk of zipChunks(entries)) parts.push(chunk);
	return Buffer.concat(parts);
}

// Streams the archive into the store and returns its size in bytes.
export async function uploadZip(
	store: Pick<AssetObjectStore, 'upload'>,
	key: string,
	entries: Iterable<ZipEntry>,
	contentType: string
): Promise<number> {
	let size = 0;
	async function* counted() {
		for await (const chunk of zipChunks(entries)) {
			size += chunk.byteLength;
			yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		}
	}
	await store.upload(key, Readable.from(counted()), contentType);
	return size;
}
