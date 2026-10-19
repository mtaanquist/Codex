import { Readable } from 'node:stream';
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { AssetObjectStore } from './assets.ts';

// Exports and edition files are written as a stream: entries go into the zip
// one at a time and the output flows straight to the bucket, so neither the
// finished archive nor every bundled image sits in memory at once. Runs in the
// worker, so relative value imports carry explicit .ts extensions.

// An entry's content: bytes already in hand (prose), or a function that opens
// a stream (a bundled image read from the bucket), called only when the entry
// is written.
export type ZipSource = Uint8Array | (() => Promise<AsyncIterable<Uint8Array>>);
// `stored` skips compression: for the EPUB mimetype, which the spec requires
// uncompressed, and for images, which are compressed already.
export type ZipEntry = { path: string; data: ZipSource; stored?: boolean };
export type ZipArchive = { filename: string; entries: ZipEntry[] };

export function textEntry(path: string, text: string): ZipEntry {
	return { path, data: strToU8(text) };
}

// A bundled image, read from its source only when the zip reaches it.
export function assetEntry(
	path: string,
	asset: { open(): Promise<AsyncIterable<Uint8Array>> }
): ZipEntry {
	return { path, data: () => asset.open(), stored: true };
}

export async function* zipChunks(entries: Iterable<ZipEntry>): AsyncGenerator<Uint8Array> {
	const out: Uint8Array[] = [];
	let failure: Error | null = null;
	const zip = new Zip((error, chunk) => {
		if (error) failure = error;
		else out.push(chunk);
	});
	// fflate's Zip and ZipDeflate are synchronous, so output is ready as soon
	// as a push returns; handing it on after every push is what keeps the
	// buffer to one chunk's worth.
	function* drain(): Generator<Uint8Array> {
		if (failure) throw failure;
		while (out.length > 0) yield out.shift()!;
	}
	for (const entry of entries) {
		const file = entry.stored
			? new ZipPassThrough(entry.path)
			: new ZipDeflate(entry.path, { level: 6 });
		zip.add(file);
		if (entry.data instanceof Uint8Array) {
			file.push(entry.data, true);
		} else {
			for await (const chunk of await entry.data()) {
				file.push(chunk);
				yield* drain();
			}
			file.push(new Uint8Array(0), true);
		}
		yield* drain();
	}
	zip.end();
	yield* drain();
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
