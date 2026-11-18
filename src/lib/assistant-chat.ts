// How many recent turns the side panel sends with each chat request. The
// server keeps its summary of older turns anchored inside this window, so both
// sides read the figure from here.
export const CHAT_WINDOW_TURNS = 40;

// A chat's title, taken from its first message: whitespace collapsed and cut
// to fit a list row. The migration that created chats (0080) backfills titles
// with the same rule in SQL.
export const CHAT_TITLE_MAX = 60;

export function chatTitle(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat.length <= CHAT_TITLE_MAX) return flat;
	return `${flat.slice(0, CHAT_TITLE_MAX - 3).trimEnd()}...`;
}

// The title of a chat that starts with "Catch me up" rather than a question.
export const RECAP_CHAT_TITLE = 'Catch me up';

// A chat as the panel's picker lists it.
export type ChatSummary = { id: string; title: string; updatedAt: string };

// The message a request gets when the chat it names is gone; the panel
// matches it to tell a deleted chat from a story or universe that is gone.
export const CHAT_MISSING = 'That chat does not exist.';

// An id for a chat the panel is about to start. crypto.randomUUID only exists
// on secure pages, and a self-hosted instance may be served over plain http,
// so this falls back to building a version 4 UUID from random bytes.
export function newChatId(): string {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The composer's text after a prompt is put in it. Text the writer typed and
// has not sent stays, with the prompt after it; an earlier prompt still at the
// end, or a half-typed command, is replaced.
export function withPrompt(input: string, lastPrompt: string, prompt: string): string {
	let typed = input.trim();
	const earlier = lastPrompt.trim();
	if (earlier && typed.endsWith(earlier)) typed = typed.slice(0, -earlier.length).trim();
	return typed && !typed.startsWith('/') ? `${typed}\n\n${prompt}` : prompt;
}
