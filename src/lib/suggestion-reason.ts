// The Assistant's reason for a suggested edit is a sentence or two, kept on
// one line; a longer one is cut at a word and marked with "...".
export const MAX_REASON_LENGTH = 300;

export function normaliseReason(reason: string | undefined): string | null {
	const text = (reason ?? '').replace(/\s+/g, ' ').trim();
	if (!text) return null;
	// By code point, so a cut never splits an emoji or other paired character.
	const chars = Array.from(text);
	if (chars.length <= MAX_REASON_LENGTH) return text;
	const cut = chars.slice(0, MAX_REASON_LENGTH - 3).join('');
	const space = cut.lastIndexOf(' ');
	const kept = space > MAX_REASON_LENGTH / 2 ? cut.slice(0, space) : cut;
	return `${kept.replace(/[\s.,;:!?-]+$/, '')}...`;
}
