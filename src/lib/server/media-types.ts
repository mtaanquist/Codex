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
