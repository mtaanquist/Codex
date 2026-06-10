// The image types Codex accepts and their file extensions, in one place.
// SVG is deliberately absent: it can carry scripts, and assets are served
// back on our own origin. Uploads validate against these, and exports use
// the extensions when naming bundled files.
export const IMAGE_EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif'
};

export const IMAGE_TYPES = new Set(Object.keys(IMAGE_EXTENSIONS));

// The extension for a stored content type, with a safe fallback for the
// odd legacy row whose type is no longer in the set.
export function extensionFor(contentType: string): string {
	return IMAGE_EXTENSIONS[contentType] ?? 'bin';
}

// Detects the image type from the file's leading bytes (its magic number), so
// a client cannot store arbitrary bytes under a lying content type and have
// them served back on our own origin. Returns null when the bytes are not one
// of the accepted image types.
export function sniffImageType(bytes: Buffer): string | null {
	if (bytes.length < 4) return null;
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return 'image/png';
	}
	// JPEG: FF D8 FF
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	// GIF: "GIF8"
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
		return 'image/gif';
	}
	// WEBP: "RIFF"...."WEBP"
	if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
		return 'image/webp';
	}
	// AVIF: an ISO base-media "ftyp" box branded avif/avis.
	if (bytes.toString('ascii', 4, 8) === 'ftyp') {
		const brand = bytes.toString('ascii', 8, 12);
		if (brand === 'avif' || brand === 'avis') return 'image/avif';
	}
	return null;
}
