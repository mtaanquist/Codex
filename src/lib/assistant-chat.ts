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
