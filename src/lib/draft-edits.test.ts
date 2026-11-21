import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textHash } from './text-hash';

type Module = typeof import('./draft-edits');
// A fresh copy of the module for each test: it holds the edits of the page.
let edits: Module;

type Sent = { url: string; body: { text: string; baseHashes: string[] }; keepalive: boolean };

let sent: Sent[];
// What the next requests answer; the last entry repeats.
let answers: (() => Promise<Response> | Response)[];
let n = 0;
const id = () => `draft-${++n}`;

const ok = () => Response.json({ ok: true });
const refused = (status: number, message: string) => () => Response.json({ message }, { status });
const offline = () => Promise.reject(new TypeError('Failed to fetch'));
// An answer the test gives when it chooses.
function later() {
	let resolve: (response: Response) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const answer = () =>
		new Promise<Response>((res, rej) => {
			resolve = res;
			reject = rej;
		});
	return { answer, resolve: (r: Response) => resolve(r), reject: (e: Error) => reject(e) };
}
const sentFor = (key: string) => sent.filter((s) => s.url.endsWith(`/${key}`));
const bodies = () => sent.map((s) => s.body);

// The page and the document, as far as the module listens to them.
let page: EventTarget;
let doc: EventTarget & { visibilityState: string };
function leaving(): boolean {
	const event = new Event('beforeunload', { cancelable: true });
	page.dispatchEvent(event);
	return event.defaultPrevented;
}

beforeEach(async () => {
	vi.useFakeTimers();
	vi.resetModules();
	sent = [];
	answers = [ok];
	page = new EventTarget();
	doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
	vi.stubGlobal('window', page);
	vi.stubGlobal('document', doc);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			sent.push({
				url,
				body: JSON.parse(init.body as string),
				keepalive: init.keepalive === true
			});
			const answer = answers.length > 1 ? answers.shift()! : answers[0];
			return answer();
		})
	);
	edits = await import('./draft-edits');
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const STORED = 'As written.';
const SCENE = 'scene-1';
const stored = { textMd: STORED, sceneId: SCENE };
const h = textHash;

// Types into the edit and lets the pause before a save pass.
async function type(edit: ReturnType<Module['draftEdit']>, text: string) {
	edit.text = text;
	edit.autosave.schedule();
	await vi.advanceTimersByTimeAsync(1200);
}

describe('saving', () => {
	it('saves a moment after typing stops, with the text the edit was made from', async () => {
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edit.text = 'As w';
		edit.autosave.schedule();
		await vi.advanceTimersByTimeAsync(500);
		edit.text = 'As changed.';
		edit.autosave.schedule();
		await vi.advanceTimersByTimeAsync(1000);
		expect(sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(300);
		expect(sent).toEqual([
			{
				url: `/api/assistant/draft/${key}`,
				body: { text: 'As changed.', baseHashes: [h(STORED)] },
				keepalive: false
			}
		]);
		expect(edit.saved).toBe('As changed.');
		// The next save, and keeping the draft, build on what was saved.
		expect(edits.draftBaseHashes(edit)).toEqual([h('As changed.')]);
	});

	it('flushes before the draft is kept, and resolves once the save has landed', async () => {
		const edit = edits.draftEdit(id(), stored);
		edit.text = 'Edited, then Fill at once.';
		edit.autosave.schedule();
		const flushed = edit.autosave.flush();
		await vi.advanceTimersByTimeAsync(0);
		await flushed;
		expect(bodies().map((b) => b.text)).toEqual(['Edited, then Fill at once.']);
		expect(edit.saved).toBe('Edited, then Fill at once.');
	});

	it('says when a save failed and tries again on its own', async () => {
		const changed = vi.fn();
		answers = [refused(503, 'The server is busy.'), ok];
		const edit = edits.draftEdit(id(), stored);
		edit.onChange = changed;
		await type(edit, 'Edited.');
		expect(edit.error).toBe('The server is busy.');
		expect(edit.saved).toBe(STORED);
		expect(changed).toHaveBeenCalled();
		// No keystroke follows; the retry is the queue's own.
		await vi.advanceTimersByTimeAsync(2000);
		expect(sent).toHaveLength(2);
		expect(edit.error).toBe('');
		expect(edit.saved).toBe('Edited.');
	});

	it('tries again after a request that never reached the server', async () => {
		answers = [offline, ok];
		const edit = edits.draftEdit(id(), stored);
		await type(edit, 'Edited.');
		expect(edit.error).toMatch(/Could not save/);
		expect(edit.autosave.hasUnsaved()).toBe(true);
		await vi.advanceTimersByTimeAsync(2000);
		expect(sent).toHaveLength(2);
		expect(edit).toMatchObject({ error: '', saved: 'Edited.' });
	});

	it('does not send a blank draft, and says how to drop one', async () => {
		const edit = edits.draftEdit(id(), stored);
		await type(edit, '  \n');
		expect(sent).toEqual([]);
		expect(edit.error).toMatch(/Discard/);
		expect(edit.text).toBe('  \n');
		// Typing again saves as usual and clears the message.
		await type(edit, 'Back.');
		expect(bodies().map((b) => b.text)).toEqual(['Back.']);
		expect(edit.error).toBe('');
	});

	it('clears a message once the box is back to what is saved', async () => {
		const edit = edits.draftEdit(id(), stored);
		await type(edit, '');
		expect(edit.error).toMatch(/Discard/);
		// The writer puts the text back: there is nothing to save, or to say.
		await type(edit, STORED);
		expect(sent).toEqual([]);
		expect(edit.error).toBe('');
	});

	it('saves nothing more once the draft is decided', async () => {
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edit.text = 'Edited, then discarded.';
		edit.autosave.schedule();
		edits.dropDraftEdit(key);
		await vi.advanceTimersByTimeAsync(5000);
		expect(sent).toEqual([]);
		// A later draft with the same id would start from what the server holds.
		expect(edits.draftEdit(key, stored).text).toBe(STORED);
	});
});

describe('a save whose answer never came', () => {
	// The server took the save; the page never heard.
	it('is not a conflict when the writer keeps typing before it is tried again', async () => {
		answers = [offline, ok];
		const edit = edits.draftEdit(id(), stored);
		await type(edit, 'First.');
		expect(edit.error).toMatch(/tried again/);
		// More is typed before the retry. The server may hold either text, and
		// the save says so.
		await type(edit, 'First. Second.');
		expect(bodies()).toEqual([
			{ text: 'First.', baseHashes: [h(STORED)] },
			{ text: 'First. Second.', baseHashes: [h(STORED), h('First.')] }
		]);
		expect(edit).toMatchObject({ saved: 'First. Second.', conflict: false, error: '' });
		expect(edits.draftBaseHashes(edit)).toEqual([h('First. Second.'), h('First.')]);
	});

	it('is put right when the writer goes back to the old text', async () => {
		answers = [offline, ok];
		const edit = edits.draftEdit(id(), stored);
		await type(edit, 'First.');
		// Undone: the box is what was last confirmed saved, but the server may
		// hold "First.", so the old text is sent all the same.
		await type(edit, STORED);
		expect(bodies()[1]).toEqual({ text: STORED, baseHashes: [h(STORED), h('First.')] });
		expect(edit).toMatchObject({ saved: STORED, error: '' });
		expect(edit.autosave.hasUnsaved()).toBe(false);
	});

	it('keeps offering a text the server may hold until a save is answered for it', async () => {
		answers = [offline, offline, ok];
		const edit = edits.draftEdit(id(), stored);
		await type(edit, 'One.');
		await type(edit, 'Two.');
		await type(edit, 'Three.');
		expect(bodies()[2].baseHashes).toEqual([h(STORED), h('One.'), h('Two.')]);
	});
});

describe('a draft changed in another window', () => {
	it('is told so, once, and builds on the current text when the writer loads it', async () => {
		answers = [refused(409, 'This draft was changed in another window.')];
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edit.onChange = () => {};
		await type(edit, 'Edited in a window that fell behind.');
		expect(edit.conflict).toBe(true);
		expect(edit.error).toBe('This draft was changed in another window.');
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sent).toHaveLength(1);
		// A read of the draft does not replace the writer's text until they ask.
		expect(edits.draftEdit(key, { textMd: 'From the other window.', sceneId: SCENE }).text).toBe(
			'Edited in a window that fell behind.'
		);
		edits.adoptStored(edit, { textMd: 'From the other window.' });
		expect(edit).toMatchObject({ text: 'From the other window.', conflict: false, error: '' });
		answers = [ok];
		await type(edit, 'From the other window. And on.');
		expect(bodies()[1].baseHashes).toEqual([h('From the other window.')]);
	});

	it('with no card showing, keeps the text for the next card and asks before leaving until it is seen', async () => {
		answers = [refused(409, 'This draft was changed in another window.')];
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edit.text = 'Typed, then the panel was closed.';
		edit.autosave.schedule();
		edits.releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(0);
		expect(edit.conflict).toBe(true);
		// Nobody has been told: leaving the page asks.
		expect(leaving()).toBe(true);
		// It is not sent again as the page is hidden or left; it would be
		// refused again.
		doc.visibilityState = 'hidden';
		doc.dispatchEvent(new Event('visibilitychange'));
		page.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		// Kept however long the card stays away.
		await vi.advanceTimersByTimeAsync(600_000);
		edits.draftEdit(id(), stored);
		// The next card gets the text, with the conflict to show.
		const again = edits.draftEdit(key, { textMd: 'From the other window.', sceneId: SCENE });
		expect(again).toBe(edit);
		expect(again).toMatchObject({ text: 'Typed, then the panel was closed.', conflict: true });
		// The writer has seen it now: the page no longer asks on its account.
		expect(leaving()).toBe(false);
		edits.releaseDraftEdit(again);
		expect(leaving()).toBe(false);
	});
});

describe('a draft kept or discarded in another window', () => {
	const gone = refused(409, 'This draft was already kept or discarded.');

	it('gives the text typed and never saved to the next card of the scene, once', async () => {
		answers = [gone];
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edit.text = 'Typed, then the pane was switched.';
		edit.autosave.schedule();
		edits.releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(0);
		expect(leaving()).toBe(true);
		// Another scene's card is not offered it, nor is one still showing it.
		expect(edits.strandedDraftText('scene-2', null)).toBeNull();
		expect(edits.strandedDraftText(SCENE, key)).toBeNull();
		// The scene has no draft now, or a newer one.
		expect(edits.strandedDraftText(SCENE, null)).toEqual({
			id: key,
			text: 'Typed, then the pane was switched.'
		});
		// Said on screen now: the page does not ask, and nothing more is sent.
		expect(leaving()).toBe(false);
		edit.autosave.schedule();
		await vi.advanceTimersByTimeAsync(5000);
		expect(sent).toHaveLength(1);
		// Still there if the card goes before it is closed; gone once it is.
		expect(edits.strandedDraftText(SCENE, 'newer')?.text).toBe(
			'Typed, then the pane was switched.'
		);
		edits.dropDraftEdit(key);
		expect(edits.strandedDraftText(SCENE, null)).toBeNull();
	});

	it('has nothing to give when all that was typed is saved', async () => {
		const key = id();
		const edit = edits.draftEdit(key, stored);
		await type(edit, 'Edited and saved.');
		edits.releaseDraftEdit(edit);
		expect(edits.strandedDraftText(SCENE, null)).toBeNull();
		// And the edit is let go of.
		expect(edits.draftEdit(key, stored)).not.toBe(edit);
	});

	it('does not ask again before leaving once a card has shown a refusal', async () => {
		answers = [gone];
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edit.onChange = () => {};
		await type(edit, 'Typed.');
		expect(leaving()).toBe(false);
		// The card goes, and the writer's text is flushed: not sent, not asked.
		edits.releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(5000);
		expect(sent).toHaveLength(1);
		expect(leaving()).toBe(false);
	});
});

describe('a copy this window only looked at', () => {
	it('follows what the next read finds', async () => {
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edits.releaseDraftEdit(edit);
		const again = edits.draftEdit(key, { textMd: 'Edited in another window.', sceneId: SCENE });
		expect(again).toBe(edit);
		expect(again).toMatchObject({
			text: 'Edited in another window.',
			saved: 'Edited in another window.'
		});
		// And saves from there.
		await type(again, 'Edited in another window. And here.');
		expect(bodies()[0].baseHashes).toEqual([h('Edited in another window.')]);
	});

	it('does not once anything is typed, sent or saved here', async () => {
		const other = { textMd: 'Edited in another window.', sceneId: SCENE };
		// Typed and not sent.
		const typedKey = id();
		const typed = edits.draftEdit(typedKey, stored);
		typed.text = 'Typed.';
		expect(edits.draftEdit(typedKey, other).text).toBe('Typed.');
		// Sent and not answered.
		const slow = later();
		answers = [slow.answer];
		const key = id();
		const unanswered = edits.draftEdit(key, stored);
		await type(unanswered, 'Sent.');
		unanswered.text = STORED;
		expect(edits.draftEdit(key, other).text).toBe(STORED);
		// Saved: a read may be older than the save.
		slow.resolve(ok());
		await type(unanswered, 'Saved.');
		expect(edits.draftEdit(key, other).text).toBe('Saved.');
	});
});

describe('a card that went away and came back', () => {
	it('keeps unsaved text, and a save on its way, over what the new card reads', async () => {
		const key = id();
		const slow = later();
		answers = [slow.answer];
		const edit = edits.draftEdit(key, stored);
		edit.text = 'Edited before the panel closed.';
		edit.autosave.schedule();
		// The card goes away: the edit is sent at once, and is slow to land.
		edits.releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		// The card comes back and reads the draft before the save has landed.
		const again = edits.draftEdit(key, stored);
		expect(again).toBe(edit);
		expect(again.text).toBe('Edited before the panel closed.');
		slow.resolve(ok());
		await vi.advanceTimersByTimeAsync(0);
		expect(again.saved).toBe('Edited before the panel closed.');
		// A read that was sent before the save landed comes back with the old
		// text. It is not put back in the box.
		expect(edits.draftEdit(key, stored).text).toBe('Edited before the panel closed.');
	});

	it('lets go of an edit with nothing unsaved a while after its card went', async () => {
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edits.releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(30_000);
		edits.draftEdit(id(), stored);
		expect(edits.draftEdit(key, stored)).toBe(edit);
		edits.releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(61_000);
		edits.draftEdit(id(), stored);
		expect(edits.draftEdit(key, stored)).not.toBe(edit);
	});

	it('never lets go of an edit with unsaved text, or of one a card is showing', async () => {
		answers = [refused(503, 'Busy.')];
		const unsavedKey = id();
		const unsaved = edits.draftEdit(unsavedKey, stored);
		unsaved.text = 'Not saved yet.';
		unsaved.autosave.schedule();
		edits.releaseDraftEdit(unsaved);
		const shownKey = id();
		const shown = edits.draftEdit(shownKey, stored);
		await vi.advanceTimersByTimeAsync(600_000);
		edits.draftEdit(id(), stored);
		expect(edits.draftEdit(unsavedKey, { textMd: 'Server.', sceneId: SCENE })).toBe(unsaved);
		expect(unsaved.text).toBe('Not saved yet.');
		expect(edits.draftEdit(shownKey, { textMd: 'Server.', sceneId: SCENE })).toBe(shown);
	});

	it('stops trying, and lets go of the edit, when the draft is gone or not the writer own', async () => {
		for (const status of [403, 404]) {
			sent = [];
			answers = [refused(status, 'No.')];
			const key = id();
			const edit = edits.draftEdit(key, stored);
			edit.text = 'Edited.';
			edit.autosave.schedule();
			edits.releaseDraftEdit(edit);
			await vi.advanceTimersByTimeAsync(600_000);
			expect(sent).toHaveLength(1);
			// Freed: the next card starts from what the server holds.
			expect(edits.draftEdit(key, { textMd: 'Server.', sceneId: SCENE })).not.toBe(edit);
		}
		// With a card showing, the edit stays for the writer to read the reason.
		sent = [];
		answers = [refused(404, 'That draft is no longer there.')];
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edit.onChange = () => {};
		await type(edit, 'Edited.');
		await vi.advanceTimersByTimeAsync(600_000);
		expect(sent).toHaveLength(1);
		expect(edit.error).toBe('That draft is no longer there.');
		expect(edits.draftEdit(key, stored)).toBe(edit);
	});

	it('keeps an edit the writer was signed out under, and saves it once they are back', async () => {
		answers = [refused(401, 'Sign in to edit a draft.'), ok];
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edit.text = 'Typed, then the session ended.';
		edit.autosave.schedule();
		edits.releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(edits.draftEdit(key, { textMd: 'Server.', sceneId: SCENE })).toBe(edit);
		expect(edit.text).toBe('Typed, then the session ended.');
		// Signed in again in another tab: the retry goes through.
		await vi.advanceTimersByTimeAsync(2000);
		expect(sent).toHaveLength(2);
		expect(edit.saved).toBe('Typed, then the session ended.');
	});
});

describe('leaving the page', () => {
	it('sends an unsaved edit to outlive the page', async () => {
		const edit = edits.draftEdit(id(), stored);
		edit.text = 'Typed, then the tab was closed.';
		edit.autosave.schedule();
		expect(leaving()).toBe(true);
		page.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(sent[0].keepalive).toBe(true);
		expect(sent[0].body.text).toBe('Typed, then the tab was closed.');
		expect(leaving()).toBe(false);
	});

	it('sends an edit too large for keepalive as an ordinary request', async () => {
		const edit = edits.draftEdit(id(), stored);
		edit.text = 'x'.repeat(70 * 1024);
		edit.autosave.schedule();
		page.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(sent[0].keepalive).toBe(false);
	});

	it('sends every edit held, with or without a card, and saves when the tab is hidden', async () => {
		answers = [refused(503, 'Busy.')];
		const key = id();
		const edit = edits.draftEdit(key, stored);
		edit.text = 'Edited, and the save failed.';
		edit.autosave.schedule();
		edits.releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(0);
		expect(sentFor(key)).toHaveLength(1);
		// Waiting for its retry, with no card: leaving the page asks, and sends it.
		expect(leaving()).toBe(true);
		answers = [ok];
		page.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(0);
		expect(sentFor(key)).toHaveLength(2);
		expect(sentFor(key)[1].keepalive).toBe(true);
		expect(edit.saved).toBe('Edited, and the save failed.');
		// A tab put in the background saves what is typed without waiting.
		const otherKey = id();
		const other = edits.draftEdit(otherKey, stored);
		other.text = 'Typed, then another tab was opened.';
		other.autosave.schedule();
		doc.visibilityState = 'hidden';
		doc.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(sentFor(otherKey)).toHaveLength(1);
		expect(leaving()).toBe(false);
	});

	it('listens once, however many drafts are edited', async () => {
		const added = vi.spyOn(page, 'addEventListener');
		const addedToDoc = vi.spyOn(doc, 'addEventListener');
		// A second page object stands in for nothing: the first listen was in
		// beforeEach's import, lazily on the first edit.
		const first = edits.draftEdit(id(), stored);
		edits.draftEdit(id(), stored);
		edits.draftEdit(id(), stored);
		expect(added.mock.calls.map(([type]) => type).sort()).toEqual(['beforeunload', 'pagehide']);
		expect(addedToDoc.mock.calls.map(([type]) => type)).toEqual(['visibilitychange']);
		// So one page hide sends an edit once.
		first.text = 'Once.';
		first.autosave.schedule();
		page.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
	});

	it('sends a newer text beside a save still on its way, naming both texts the server may hold', async () => {
		const first = later();
		const second = later();
		answers = [first.answer, second.answer, ok];
		const edit = edits.draftEdit(id(), stored);
		edit.text = 'First.';
		edit.autosave.schedule();
		edit.autosave.flushSoon();
		await vi.advanceTimersByTimeAsync(0);
		// More is typed while that save is out, and the page is left.
		edit.text = 'First. Second.';
		edit.autosave.schedule();
		page.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(0);
		expect(bodies()).toEqual([
			{ text: 'First.', baseHashes: [h(STORED)] },
			// Either may land first.
			{ text: 'First. Second.', baseHashes: [h(STORED), h('First.')] }
		]);
		expect(sent[1].keepalive).toBe(true);
		// The page lives on (the back-forward cache). The newer answer comes
		// first, then the older one, which must not turn the state back.
		second.resolve(ok());
		await vi.advanceTimersByTimeAsync(0);
		first.resolve(ok());
		await vi.advanceTimersByTimeAsync(0);
		expect(edit).toMatchObject({ saved: 'First. Second.', error: '' });
		expect(edits.draftBaseHashes(edit)).toEqual([h('First. Second.')]);
	});

	it('says nothing of an older save that fails after a newer one landed', async () => {
		const first = later();
		const second = later();
		answers = [first.answer, second.answer, ok];
		const edit = edits.draftEdit(id(), stored);
		edit.text = 'First.';
		edit.autosave.schedule();
		edit.autosave.flushSoon();
		await vi.advanceTimersByTimeAsync(0);
		edit.text = 'First. Second.';
		edit.autosave.schedule();
		page.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(0);
		second.resolve(ok());
		await vi.advanceTimersByTimeAsync(0);
		// The older request died with the page that was being left.
		first.reject(new TypeError('Failed to fetch'));
		await vi.advanceTimersByTimeAsync(0);
		expect(edit).toMatchObject({ saved: 'First. Second.', error: '' });
		// And nothing is sent again on its account.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sent).toHaveLength(2);
	});
});
