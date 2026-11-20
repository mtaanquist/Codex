import {
	createAutosave,
	keepaliveFits,
	saveFailure,
	UnretryableSaveError,
	type Autosave
} from './autosave';
import { apiErrorMessage } from './format';
import { DRAFT_EMPTY_SAVE } from './scene-draft';

// The writer's edits to a draft that is waiting to be kept, by draft id. Held
// here and not in the card, so text not yet saved and a save still on its way
// outlive the card: closing the panel and coming back shows the edit, not the
// older text a quick read of the server would give. Saves go through the
// shared autosave queue (debounced, chained, retried with a back-off), and
// each carries the version of the text it was made from, so a copy in another
// window that has fallen behind is refused instead of replacing newer text.
// Leaving the page is handled here too, once for every edit held, so one
// whose card has gone is still sent.

const SAVE_AFTER_MS = 1200;
// How long an edit with nothing unsaved is kept after its card went. Long
// enough for a read sent before its last save landed to come back.
const KEEP_RELEASED_MS = 60_000;

export type DraftEdit = {
	// The text as the writer has it.
	text: string;
	// The text the server holds, as far as this page knows, and its version.
	saved: string;
	version: string;
	// Why the last save did not go through; empty when it did.
	error: string;
	// The save was refused because the draft changed elsewhere. It is not
	// retried: the writer loads the current text first.
	conflict: boolean;
	autosave: Autosave;
	// The card showing this draft, told when error or conflict change.
	onChange?: () => void;
};

type Stored = { textMd: string; textVersion: string };

type Held = {
	edit: DraftEdit;
	// Versions this page has saved over. A read that comes back with one of
	// them is older than what the page holds, and is not taken.
	past: Set<string>;
	// The text of the save on its way, and which request that is.
	sending: string | null;
	sendingSeq: number;
	// Requests are numbered; an answer older than one already taken is not.
	seq: number;
	applied: number;
	// When the card let go of the edit; null while one shows it.
	releasedAt: number | null;
};

const held = new Map<string, Held>();
const byEdit = new WeakMap<DraftEdit, Held>();

/**
 * The edit state for a draft, made from what the server holds the first time.
 * One that has unsaved text, or a save on its way, keeps its own text over
 * what was just read, and so does one handed a version it has saved over.
 */
export function draftEdit(id: string, stored: Stored): DraftEdit {
	listen();
	const now = held.get(id);
	if (now) {
		now.releasedAt = null;
		const edit = now.edit;
		if (
			stored.textVersion !== edit.version &&
			!now.past.has(stored.textVersion) &&
			edit.text === edit.saved &&
			!edit.autosave.hasUnsaved() &&
			!edit.conflict
		) {
			adoptStored(edit, stored);
		}
		return edit;
	}
	sweep();
	const edit: DraftEdit = {
		text: stored.textMd,
		saved: stored.textMd,
		version: stored.textVersion,
		error: '',
		conflict: false,
		autosave: createAutosave({
			debounceMs: SAVE_AFTER_MS,
			save: ({ keepalive }) => save(id, entry, keepalive)
		})
	};
	const entry: Held = {
		edit,
		past: new Set(),
		sending: null,
		sendingSeq: 0,
		seq: 0,
		applied: 0,
		releasedAt: null
	};
	held.set(id, entry);
	byEdit.set(edit, entry);
	return edit;
}

// The stored text moved from one version to another, as this page knows it.
function moveVersion(entry: Held, version: string) {
	if (entry.edit.version !== version) entry.past.add(entry.edit.version);
	entry.past.delete(version);
	entry.edit.version = version;
}

async function save(id: string, entry: Held, keepalive: boolean): Promise<void> {
	const edit = entry.edit;
	const sending = edit.text;
	// Another save of other text is on its way and would land after this
	// point, so the text is sent even when it is what the server last held.
	const overtaking = entry.sending !== null && entry.sending !== sending;
	if (sending === edit.saved && !overtaking) return;
	// The server refuses to blank a draft; the box keeps what the writer left
	// in it, and Discard is how a draft is dropped.
	if (!sending.trim()) {
		edit.error = DRAFT_EMPTY_SAVE;
		edit.onChange?.();
		return;
	}
	// A save made as the page is left goes out beside one still on its way.
	// Either may land first, so it names that text as well as the base.
	const body = JSON.stringify({
		text: sending,
		base: edit.version,
		...(overtaking ? { sent: entry.sending } : {})
	});
	const mine = ++entry.seq;
	entry.sending = sending;
	entry.sendingSeq = mine;
	let response: Response;
	try {
		response = await fetch(`/api/assistant/draft/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			// A body too large for keepalive goes as an ordinary request; the page
			// asks before it is left with an edit unsaved (warnBeforeUnload).
			keepalive: keepalive && keepaliveFits(body),
			body
		});
	} catch (err) {
		if (mine < entry.applied) return;
		edit.error = 'Could not save your changes to the draft. It will be tried again.';
		edit.onChange?.();
		throw err;
	} finally {
		if (entry.sendingSeq === mine) entry.sending = null;
	}
	// A newer save has landed since; this answer says nothing about it.
	if (mine < entry.applied) return;
	if (!response.ok) {
		edit.conflict = response.status === 409;
		edit.error = await apiErrorMessage(response, 'Could not save your changes to the draft.');
		const shown = edit.onChange !== undefined;
		edit.onChange?.();
		// Signed out, not the writer's, or decided elsewhere: sending it again
		// would fail the same way. With no card to say so, the edit is let go.
		if ([401, 403, 404].includes(response.status)) {
			if (!shown) forget(id);
			throw new UnretryableSaveError(`save failed: ${response.status}`);
		}
		throw saveFailure(response.status);
	}
	const { textVersion } = (await response.json()) as { textVersion: string };
	entry.applied = mine;
	edit.saved = sending;
	moveVersion(entry, textVersion);
	edit.error = '';
	edit.conflict = false;
	edit.onChange?.();
}

/** Takes the server's text over the writer's copy (after a conflict). */
export function adoptStored(edit: DraftEdit, stored: Stored): void {
	const entry = byEdit.get(edit);
	if (entry) moveVersion(entry, stored.textVersion);
	else edit.version = stored.textVersion;
	edit.text = stored.textMd;
	edit.saved = stored.textMd;
	edit.error = '';
	edit.conflict = false;
	edit.onChange?.();
}

/** The card showing the draft went away: the edit saves on its own. */
export function releaseDraftEdit(edit: DraftEdit): void {
	edit.onChange = undefined;
	edit.autosave.flushSoon();
	const entry = byEdit.get(edit);
	if (entry) entry.releasedAt = Date.now();
}

/** The draft was kept or discarded: nothing more of it is saved. */
export function dropDraftEdit(id: string): void {
	const entry = held.get(id);
	if (!entry) return;
	entry.edit.onChange = undefined;
	forget(id);
}

function forget(id: string) {
	const entry = held.get(id);
	if (!entry) return;
	entry.edit.text = entry.edit.saved;
	void entry.edit.autosave.teardown();
	held.delete(id);
}

// Lets go of edits whose card went a while ago and that have nothing unsaved
// (drafts since decided in another window, or simply left).
function sweep() {
	const before = Date.now() - KEEP_RELEASED_MS;
	for (const [id, entry] of held) {
		const edit = entry.edit;
		if (entry.releasedAt === null || entry.releasedAt > before) continue;
		if (edit.text === edit.saved && !edit.autosave.hasUnsaved()) forget(id);
	}
}

// Leaving the page: every edit held is sent, whether or not a card shows it,
// and the browser asks first while one is unsaved.
let listeningOn: unknown;
function listen() {
	if (typeof window === 'undefined' || listeningOn === window) return;
	listeningOn = window;
	window.addEventListener('pagehide', () => {
		for (const entry of held.values()) entry.edit.autosave.flushOnPageHide();
	});
	window.addEventListener('beforeunload', (event) => {
		for (const entry of held.values()) entry.edit.autosave.warnBeforeUnload(event);
	});
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState !== 'hidden') return;
		for (const entry of held.values()) entry.edit.autosave.flushSoon();
	});
}
