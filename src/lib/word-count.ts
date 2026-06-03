/** Count words in a string of prose: whitespace-delimited, edges trimmed. */
export function wordCount(text: string): number {
	const trimmed = text.trim();
	return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}
