// A zip whose central directory lists `count` stored entries that all point at
// the same local entry, each declaring an uncompressed size of 0. A reader that
// trusts the declared sizes sees an empty archive; one that copies each stored
// entry by its compressed size unpacks `count` copies of the payload.
export function overlappingStoredZip(count: number, payloadBytes: number): Uint8Array {
	const local = new Uint8Array(30 + 1 + payloadBytes);
	const localView = new DataView(local.buffer);
	localView.setUint32(0, 0x04034b50, true);
	localView.setUint32(18, payloadBytes, true);
	localView.setUint16(26, 1, true);
	local[30] = 0x61;
	local.fill(0x78, 31);

	const headers: Uint8Array[] = [];
	for (let i = 0; i < count; i++) {
		const name = new TextEncoder().encode(`f${i}`);
		const header = new Uint8Array(46 + name.length);
		const view = new DataView(header.buffer);
		view.setUint32(0, 0x02014b50, true);
		view.setUint32(20, payloadBytes, true);
		view.setUint16(28, name.length, true);
		header.set(name, 46);
		headers.push(header);
	}
	const directoryLength = headers.reduce((sum, h) => sum + h.length, 0);

	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, 0x06054b50, true);
	endView.setUint16(8, count, true);
	endView.setUint16(10, count, true);
	endView.setUint32(12, directoryLength, true);
	endView.setUint32(16, local.length, true);

	const out = new Uint8Array(local.length + directoryLength + end.length);
	out.set(local, 0);
	let offset = local.length;
	for (const header of headers) {
		out.set(header, offset);
		offset += header.length;
	}
	out.set(end, offset);
	return out;
}
