import {
	defaultEffort,
	EFFORT_LEVELS,
	modelTakesEffort,
	type EffortLevel
} from './assistant-tuning.ts';
import { isUuid } from './slug.ts';

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

// The model and effort one chat runs on, picked from the composer's model chip.
// Either field absent means the usual default (the story's model, else the
// account's). Stored on the chat, so it lasts as long as the chat does.
export type ChatModelSettings = { model?: string; effort?: EffortLevel };

const MAX_MODEL_ID = 200;

// Request input is untrusted: anything that is not a plausible model id or a
// known effort level is dropped rather than refused.
export function readChatSettings(raw: unknown): ChatModelSettings {
	if (!raw || typeof raw !== 'object') return {};
	const { model, effort } = raw as { model?: unknown; effort?: unknown };
	const out: ChatModelSettings = {};
	if (typeof model === 'string' && model.trim() && model.trim().length <= MAX_MODEL_ID) {
		out.model = model.trim();
	}
	if (typeof effort === 'string' && (EFFORT_LEVELS as readonly string[]).includes(effort)) {
		out.effort = effort as EffortLevel;
	}
	return out;
}

// What the model chip needs to show the default: the model the chat role runs
// on without a chat setting, its effort where the model takes one, and whether
// the endpoint is Claude (the only provider with effort levels).
export type ChatModelInfo = { model: string; effort: EffortLevel | null; claude: boolean };

// The effort the chip shows, or null where the model takes none. A model the
// chat picked leaves the account's effort behind (the server drops it too).
export function chatEffort(settings: ChatModelSettings, info: ChatModelInfo): EffortLevel | null {
	const model = settings.model ?? info.model;
	if (!info.claude || !modelTakesEffort(model)) return null;
	if (settings.effort) return settings.effort;
	const swapped = settings.model !== undefined && settings.model !== info.model;
	return (swapped ? null : info.effort) ?? defaultEffort('chat');
}

// Something the writer added to a message as context, shown as a chip in the
// composer and over the sent message. The server reads the content itself by
// id (and checks it is the writer's); the label is only for display. A story
// goes in as its outline and summaries, or as the whole book.
export const ATTACHMENT_KINDS = ['scene', 'chapter', 'entity', 'note', 'story'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export type StoryDepth = 'outline' | 'book';
export type ChatAttachment = {
	kind: AttachmentKind;
	id: string;
	label: string;
	depth?: StoryDepth;
	// Set by the server when the content did not fit and was cut.
	shortened?: boolean;
};

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_LABEL = 120;

// Request input is untrusted: malformed entries are dropped, duplicates
// collapse, and the list is capped.
export function readAttachments(raw: unknown): ChatAttachment[] {
	if (!Array.isArray(raw)) return [];
	const out: ChatAttachment[] = [];
	for (const item of raw) {
		if (out.length >= MAX_ATTACHMENTS) break;
		if (!item || typeof item !== 'object') continue;
		const { kind, id, label, depth, shortened } = item as Record<string, unknown>;
		if (!(ATTACHMENT_KINDS as readonly unknown[]).includes(kind)) continue;
		if (typeof id !== 'string' || !isUuid(id)) continue;
		const attachment: ChatAttachment = {
			kind: kind as AttachmentKind,
			id,
			label: typeof label === 'string' ? label.trim().slice(0, MAX_ATTACHMENT_LABEL) : ''
		};
		if (kind === 'story') attachment.depth = depth === 'book' ? 'book' : 'outline';
		if (shortened === true) attachment.shortened = true;
		if (out.some((a) => attachmentKey(a) === attachmentKey(attachment))) continue;
		out.push(attachment);
	}
	return out;
}

// One attachment's identity: a story attached as outline and as whole book
// are two attachments.
export function attachmentKey(a: Pick<ChatAttachment, 'kind' | 'id' | 'depth'>): string {
	return a.depth ? `${a.kind}:${a.id}:${a.depth}` : `${a.kind}:${a.id}`;
}

// What the chat endpoint says it sent of the newest message's attachments
// (the x-chat-attachments header): each one's key, "!" when it was cut to fit,
// then "=" and the name it was stored under, URI-encoded.
export function attachedHeader(attachments: ChatAttachment[]): string[] {
	return attachments.map(
		(a) => `${attachmentKey(a)}${a.shortened ? '!' : ''}=${encodeURIComponent(a.label)}`
	);
}

export function parseAttachedHeader(
	header: string
): Map<string, { shortened: boolean; label?: string }> {
	const out = new Map<string, { shortened: boolean; label?: string }>();
	for (const entry of header.split(',')) {
		if (!entry) continue;
		const at = entry.indexOf('=');
		const head = at === -1 ? entry : entry.slice(0, at);
		let label: string | undefined;
		if (at !== -1) {
			try {
				label = decodeURIComponent(entry.slice(at + 1));
			} catch {
				// A name that does not decode leaves the chip as it was.
			}
		}
		out.set(head.replace(/!$/, ''), {
			shortened: head.endsWith('!'),
			...(label !== undefined ? { label } : {})
		});
	}
	return out;
}

// A chip's text: the label, with what a story brings along.
export function attachmentLabel(attachment: ChatAttachment): string {
	const label = attachment.label || 'Untitled';
	if (attachment.kind !== 'story') return label;
	return `${label} (${attachment.depth === 'book' ? 'whole book' : 'outline'})`;
}

// A chat as the panel's picker lists it.
export type ChatSummary = { id: string; title: string; updatedAt: string };

// The message a request gets when the chat it names is gone; the panel
// matches it to tell a deleted chat from a story or universe that is gone.
export const CHAT_MISSING = 'That chat does not exist.';

// What the panel shows for a reply that was cut short before any text
// arrived. The stored reply stays empty, so this is never sent as history.
export const NO_REPLY_TEXT = 'The Assistant did not return a response.';

// On a failed chat request: "0" says the message was not stored, so the panel
// can put it back in the chat box.
export const CHAT_STORED_HEADER = 'x-chat-stored';

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
