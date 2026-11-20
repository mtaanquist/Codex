import { createAutosave, keepaliveFits, saveFailure, type Autosave } from './autosave';
import { apiErrorMessage } from './format';

// The writer's edits to a draft that is waiting to be kept, by draft id. Held
// here and not in the card, so text not yet saved and a save still on its way
// outlive the card: closing the panel and coming back shows the edit, not the
// older text a quick read of the server would give. Saves go through the
// shared autosave queue (debounced, chained, retried with a back-off), and
// each carries the version of the text it was made from, so a copy in another
// window that has fallen behind is refused instead of replacing newer text.

const SAVE_AFTER_MS = 1200;

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

const edits = new Map<string, DraftEdit>();

/**
 * The edit state for a draft, made from what the server holds the first time.
 * One that has unsaved text, or a save on its way, keeps its own text over
 * what was just read.
 */
export function draftEdit(id: string, stored: Stored): DraftEdit {
	const held = edits.get(id);
	if (held) {
		if (held.text === held.saved && !held.autosave.hasUnsaved() && !held.conflict) {
			adoptStored(held, stored);
		}
		return held;
	}
	const edit: DraftEdit = {
		text: stored.textMd,
		saved: stored.textMd,
		version: stored.textVersion,
		error: '',
		conflict: false,
		autosave: createAutosave({
			debounceMs: SAVE_AFTER_MS,
			save: ({ keepalive }) => save(id, edit, keepalive)
		})
	};
	edits.set(id, edit);
	return edit;
}

async function save(id: string, edit: DraftEdit, keepalive: boolean): Promise<void> {
	const sending = edit.text;
	if (sending === edit.saved) return;
	const body = JSON.stringify({ text: sending, base: edit.version });
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
		edit.error = 'Could not save your changes to the draft. It will be tried again.';
		edit.onChange?.();
		throw err;
	}
	if (!response.ok) {
		edit.conflict = response.status === 409;
		edit.error = await apiErrorMessage(response, 'Could not save your changes to the draft.');
		edit.onChange?.();
		throw saveFailure(response.status);
	}
	const { textVersion } = (await response.json()) as { textVersion: string };
	edit.saved = sending;
	edit.version = textVersion;
	edit.error = '';
	edit.conflict = false;
	edit.onChange?.();
}

/** Takes the server's text over the writer's copy (after a conflict). */
export function adoptStored(edit: DraftEdit, stored: Stored): void {
	edit.text = stored.textMd;
	edit.saved = stored.textMd;
	edit.version = stored.textVersion;
	edit.error = '';
	edit.conflict = false;
	edit.onChange?.();
}

/** The draft was kept or discarded: nothing more of it is saved. */
export function dropDraftEdit(id: string): void {
	const edit = edits.get(id);
	if (!edit) return;
	edit.text = edit.saved;
	edit.onChange = undefined;
	void edit.autosave.teardown();
	edits.delete(id);
}
