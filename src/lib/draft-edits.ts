import {
	createAutosave,
	keepaliveFits,
	saveFailure,
	UnretryableSaveError,
	type Autosave
} from './autosave';
import { apiErrorMessage } from './format';
import { createSaveBases, type SaveBases } from './save-bases';
import { DRAFT_EMPTY_SAVE, isBlankDraft } from './scene-draft';

// The writer's edits to a draft that is waiting to be kept, by draft id. Held
// here and not in the card, so text not yet saved and a save still on its way
// outlive the card: closing the panel and coming back shows the edit, not the
// older text a quick read of the server would give. Saves go through the
// shared autosave queue (debounced, chained, retried with a back-off). Each
// carries the fingerprints of the texts this page has saved or may have saved
// (see save-bases, as the scene editor does), so a copy in another window
// that has fallen behind is refused instead of replacing newer text, while a
// save whose answer was lost is not mistaken for one.
// Leaving the page is handled here too, once for every edit held, so one
// whose card has gone is still sent.

const SAVE_AFTER_MS = 1200;
// How long an edit with nothing unsaved is kept after its card went. Long
// enough for a read sent before its last save landed to come back.
const KEEP_RELEASED_MS = 60_000;

export type DraftEdit = {
	// The text as the writer has it.
	text: string;
	// The text the server last confirmed it holds.
	saved: string;
	// Why the last save did not go through; empty when it did.
	error: string;
	// The save was refused because the draft changed elsewhere. It is not
	// retried: the writer loads the current text first.
	conflict: boolean;
	autosave: Autosave;
	// The card showing this draft, told when error or conflict change.
	onChange?: () => void;
};

type Held = {
	edit: DraftEdit;
	bases: SaveBases;
	// Requests are numbered; an answer older than one already taken is not.
	seq: number;
	applied: number;
	// When the card let go of the edit; null while one shows it.
	releasedAt: number | null;
	// A card has shown the writer that the draft changed elsewhere.
	conflictSeen: boolean;
};

const held = new Map<string, Held>();
const byEdit = new WeakMap<DraftEdit, Held>();

/**
 * The edit state for a draft, made from what the server holds the first time
 * a card shows it. After that the page's own copy stands: a read may be older
 * than a save this page made, and a change from another window shows as a
 * refused save, which the writer settles by loading the current text.
 */
export function draftEdit(id: string, stored: { textMd: string }): DraftEdit {
	listen();
	const now = held.get(id);
	if (now) {
		now.releasedAt = null;
		if (now.edit.conflict) now.conflictSeen = true;
		return now.edit;
	}
	sweep();
	const edit: DraftEdit = {
		text: stored.textMd,
		saved: stored.textMd,
		error: '',
		conflict: false,
		autosave: createAutosave({
			debounceMs: SAVE_AFTER_MS,
			save: ({ keepalive }) => save(id, entry, keepalive)
		})
	};
	const entry: Held = {
		edit,
		bases: createSaveBases(stored.textMd),
		seq: 0,
		applied: 0,
		releasedAt: null,
		conflictSeen: false
	};
	held.set(id, entry);
	byEdit.set(edit, entry);
	return edit;
}

/** The fingerprints to send when the draft is kept (see save-bases). */
export function draftBaseHashes(edit: DraftEdit): string[] {
	return byEdit.get(edit)?.bases.current() ?? [];
}

async function save(id: string, entry: Held, keepalive: boolean): Promise<void> {
	const { edit, bases } = entry;
	const sending = edit.text;
	// Nothing to send: the server holds this text, and no save of other text
	// is unaccounted for.
	if (sending === edit.saved && !bases.unsettled()) {
		if (!edit.conflict) setError(edit, '');
		return;
	}
	// The server refuses to blank a draft; the box keeps what the writer left
	// in it, and Discard is how a draft is dropped.
	if (isBlankDraft(sending)) {
		setError(edit, DRAFT_EMPTY_SAVE);
		return;
	}
	const mine = ++entry.seq;
	const { hash, baseHashes } = bases.begin(sending);
	const body = JSON.stringify({ text: sending, baseHashes });
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
		// Its outcome is unknown, so the text stays one the server may hold.
		if (mine < entry.applied) return;
		setError(edit, 'Could not save your changes to the draft. It will be tried again.');
		throw err;
	}
	bases.answered(hash);
	// A newer save has landed since; this answer says nothing about it.
	if (mine < entry.applied) return;
	if (!response.ok) {
		edit.conflict = response.status === 409;
		const shown = edit.onChange !== undefined;
		if (edit.conflict) entry.conflictSeen = shown;
		setError(edit, await apiErrorMessage(response, 'Could not save your changes to the draft.'));
		// Not the writer's, or decided elsewhere: sending it again would fail
		// the same way. With no card to say so, the edit is let go.
		if (response.status === 403 || response.status === 404) {
			if (!shown) forget(id);
			throw new UnretryableSaveError(`save failed: ${response.status}`);
		}
		throw saveFailure(response.status);
	}
	entry.applied = mine;
	bases.landed(hash);
	edit.saved = sending;
	edit.conflict = false;
	setError(edit, '');
}

function setError(edit: DraftEdit, error: string) {
	edit.error = error;
	edit.onChange?.();
}

/** Takes the server's text over the writer's copy (after a conflict). */
export function adoptStored(edit: DraftEdit, stored: { textMd: string }): void {
	byEdit.get(edit)?.bases.reset(stored.textMd);
	edit.text = stored.textMd;
	edit.saved = stored.textMd;
	edit.conflict = false;
	setError(edit, '');
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

// An edit refused because the draft changed elsewhere, once the writer has
// been shown that: sending it again would be refused again, and asking before
// the page is left would ask for the rest of the page's life. The text stays
// for the card.
function settledConflict(entry: Held): boolean {
	return entry.edit.conflict && entry.conflictSeen;
}

// Leaving the page: every edit held is sent, whether or not a card shows it,
// and the browser asks first while one is unsaved.
let listeningOn: unknown;
function listen() {
	if (typeof window === 'undefined' || listeningOn === window) return;
	listeningOn = window;
	window.addEventListener('pagehide', () => {
		for (const entry of held.values()) {
			if (!entry.edit.conflict) entry.edit.autosave.flushOnPageHide();
		}
	});
	window.addEventListener('beforeunload', (event) => {
		for (const entry of held.values()) {
			if (!settledConflict(entry)) entry.edit.autosave.warnBeforeUnload(event);
		}
	});
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState !== 'hidden') return;
		for (const entry of held.values()) {
			if (!entry.edit.conflict) entry.edit.autosave.flushSoon();
		}
	});
}
