import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptStored, draftEdit, dropDraftEdit, releaseDraftEdit } from './draft-edits';

type Sent = {
	url: string;
	body: { text: string; base: string; sent?: string };
	keepalive: boolean;
};

let sent: Sent[];
// What the next requests answer; the last entry repeats.
let answers: (() => Promise<Response> | Response)[];
let n = 0;
const id = () => `draft-${++n}`;

const ok = (textVersion: string) => () => Response.json({ ok: true, textVersion });
const refused = (status: number, message: string) => () => Response.json({ message }, { status });

beforeEach(() => {
	vi.useFakeTimers();
	sent = [];
	answers = [ok('v2')];
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
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const stored = { textMd: 'As written.', textVersion: 'v1' };

describe('draft edits', () => {
	it('saves a moment after typing stops, with the version the edit was made from', async () => {
		const key = id();
		const edit = draftEdit(key, stored);
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
				body: { text: 'As changed.', base: 'v1' },
				keepalive: false
			}
		]);
		expect(edit.saved).toBe('As changed.');
		expect(edit.version).toBe('v2');
	});

	it('keeps unsaved text, and a save on its way, over what a new card reads', async () => {
		const key = id();
		let release: (response: Response) => void = () => {};
		answers = [() => new Promise<Response>((resolve) => (release = resolve))];
		const edit = draftEdit(key, stored);
		edit.text = 'Edited before the panel closed.';
		edit.autosave.schedule();
		// The card goes away: the edit is sent at once, and is slow to land.
		edit.autosave.flushSoon();
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		// The card comes back and reads the draft before the save has landed.
		const again = draftEdit(key, stored);
		expect(again).toBe(edit);
		expect(again.text).toBe('Edited before the panel closed.');
		release(Response.json({ ok: true, textVersion: 'v2' }));
		await vi.advanceTimersByTimeAsync(0);
		expect(again.saved).toBe('Edited before the panel closed.');
		expect(again.version).toBe('v2');
		// A read that was sent before the save landed comes back with the text
		// this window has saved over. It is not put back in the box.
		expect(draftEdit(key, stored).text).toBe('Edited before the panel closed.');
		expect(again.version).toBe('v2');
		// A version this window has never held is another window's: with nothing
		// unsaved, it is taken.
		expect(draftEdit(key, { textMd: 'From another window.', textVersion: 'v3' }).text).toBe(
			'From another window.'
		);
		// And what that replaced is now behind it too.
		expect(
			draftEdit(key, { textMd: 'Edited before the panel closed.', textVersion: 'v2' }).text
		).toBe('From another window.');
	});

	it('names the save still on its way when a newer one goes out as the page is left', async () => {
		const key = id();
		const releases: ((response: Response) => void)[] = [];
		answers = [() => new Promise<Response>((resolve) => releases.push(resolve))];
		const edit = draftEdit(key, stored);
		edit.text = 'First.';
		edit.autosave.schedule();
		edit.autosave.flushSoon();
		await vi.advanceTimersByTimeAsync(0);
		// More is typed while that save is out, and the page is left.
		edit.text = 'First. Second.';
		edit.autosave.schedule();
		edit.autosave.flushOnPageHide();
		await vi.advanceTimersByTimeAsync(0);
		expect(sent.map((s) => s.body)).toEqual([
			{ text: 'First.', base: 'v1' },
			// Either may land first: the server takes this one over the base or
			// over the text of the save beside it.
			{ text: 'First. Second.', base: 'v1', sent: 'First.' }
		]);
		expect(sent[1].keepalive).toBe(true);
		// The page lives on (the back-forward cache). The newer answer comes
		// first, then the older one, which must not turn the state back.
		releases[1](Response.json({ ok: true, textVersion: 'v3' }));
		await vi.advanceTimersByTimeAsync(0);
		releases[0](Response.json({ ok: true, textVersion: 'v2' }));
		await vi.advanceTimersByTimeAsync(0);
		expect(edit).toMatchObject({ saved: 'First. Second.', version: 'v3', error: '' });
		expect(edit.autosave.hasUnsaved()).toBe(false);
		// The same text still on its way is simply sent again.
		edit.text = 'Third.';
		edit.autosave.schedule();
		edit.autosave.flushSoon();
		await vi.advanceTimersByTimeAsync(0);
		edit.autosave.flushOnPageHide();
		await vi.advanceTimersByTimeAsync(0);
		expect(sent.slice(2).map((s) => s.body)).toEqual([
			{ text: 'Third.', base: 'v3' },
			{ text: 'Third.', base: 'v3' }
		]);
	});

	it('stops trying, and lets go of the edit, when the draft is gone or the writer signed out', async () => {
		for (const status of [401, 403, 404]) {
			sent = [];
			answers = [refused(status, 'No.')];
			const key = id();
			const edit = draftEdit(key, stored);
			edit.text = 'Edited.';
			edit.autosave.schedule();
			// The card has gone; the save is the module's own.
			releaseDraftEdit(edit);
			await vi.advanceTimersByTimeAsync(0);
			expect(sent).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(600_000);
			expect(sent).toHaveLength(1);
			// Freed: the next card starts from what the server holds.
			expect(draftEdit(key, { textMd: 'Server.', textVersion: 'v7' })).not.toBe(edit);
		}
		// With a card showing, the edit stays for the writer to read the reason.
		sent = [];
		answers = [refused(404, 'That draft is no longer there.')];
		const key = id();
		const edit = draftEdit(key, stored);
		edit.onChange = () => {};
		edit.text = 'Edited.';
		edit.autosave.schedule();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(sent).toHaveLength(1);
		expect(edit.error).toBe('That draft is no longer there.');
		expect(draftEdit(key, stored)).toBe(edit);
	});

	it('lets go of an edit with nothing unsaved a while after its card went', async () => {
		const key = id();
		const edit = draftEdit(key, stored);
		releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(30_000);
		draftEdit(id(), stored);
		expect(draftEdit(key, stored)).toBe(edit);
		releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(61_000);
		draftEdit(id(), stored);
		expect(draftEdit(key, stored)).not.toBe(edit);
	});

	it('sends every edit held when the page is left, and asks first, with or without a card', async () => {
		const page = new EventTarget();
		const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
		vi.stubGlobal('window', page);
		vi.stubGlobal('document', doc);
		// Edits left by other tests are held too; only these two are counted.
		const sentFor = (key: string) => sent.filter((s) => s.url.endsWith(`/${key}`));
		answers = [refused(503, 'Busy.')];
		const key = id();
		const edit = draftEdit(key, stored);
		edit.text = 'Edited, and the save failed.';
		edit.autosave.schedule();
		releaseDraftEdit(edit);
		await vi.advanceTimersByTimeAsync(0);
		expect(sentFor(key)).toHaveLength(1);
		// Waiting for its retry, with no card: leaving the page asks, and sends it.
		const leaving = new Event('beforeunload', { cancelable: true });
		page.dispatchEvent(leaving);
		expect(leaving.defaultPrevented).toBe(true);
		answers = [ok('v2')];
		page.dispatchEvent(new Event('pagehide'));
		await vi.advanceTimersByTimeAsync(0);
		expect(sentFor(key)).toHaveLength(2);
		expect(sentFor(key)[1].keepalive).toBe(true);
		expect(edit.saved).toBe('Edited, and the save failed.');
		// A tab put in the background saves what is typed without waiting.
		const otherKey = id();
		const other = draftEdit(otherKey, stored);
		other.text = 'Typed, then another tab was opened.';
		other.autosave.schedule();
		doc.visibilityState = 'hidden';
		doc.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(sentFor(otherKey)).toHaveLength(1);
	});

	it('flushes before the draft is kept, and resolves once the save has landed', async () => {
		const edit = draftEdit(id(), stored);
		edit.text = 'Edited, then Fill at once.';
		edit.autosave.schedule();
		const flushed = edit.autosave.flush();
		await vi.advanceTimersByTimeAsync(0);
		await flushed;
		expect(sent.map((s) => s.body.text)).toEqual(['Edited, then Fill at once.']);
		expect(edit.version).toBe('v2');
	});

	it('says when a save failed and tries again on its own', async () => {
		const changed = vi.fn();
		answers = [refused(503, 'The server is busy.'), ok('v2')];
		const edit = draftEdit(id(), stored);
		edit.onChange = changed;
		edit.text = 'Edited.';
		edit.autosave.schedule();
		await vi.advanceTimersByTimeAsync(1200);
		expect(edit.error).toBe('The server is busy.');
		expect(edit.saved).toBe('As written.');
		expect(changed).toHaveBeenCalled();
		// No keystroke follows; the retry is the queue's own.
		await vi.advanceTimersByTimeAsync(2000);
		expect(sent).toHaveLength(2);
		expect(edit.error).toBe('');
		expect(edit.saved).toBe('Edited.');
	});

	it('does not repeat a save refused because the draft changed elsewhere', async () => {
		answers = [refused(409, 'This draft was changed in another window.')];
		const edit = draftEdit(id(), stored);
		edit.text = 'Edited in a window that fell behind.';
		edit.autosave.schedule();
		await vi.advanceTimersByTimeAsync(1200);
		expect(edit.conflict).toBe(true);
		expect(edit.error).toBe('This draft was changed in another window.');
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sent).toHaveLength(1);
		// A read of the draft does not replace the writer's text until they ask.
		expect(draftEdit(sent[0].url.split('/').pop()!, stored).text).toBe(
			'Edited in a window that fell behind.'
		);
		adoptStored(edit, { textMd: 'From the other window.', textVersion: 'v9' });
		expect(edit).toMatchObject({
			text: 'From the other window.',
			version: 'v9',
			conflict: false,
			error: ''
		});
	});

	it('sends an unsaved edit as the page is left, to outlive it', async () => {
		const edit = draftEdit(id(), stored);
		edit.text = 'Typed, then the tab was closed.';
		edit.autosave.schedule();
		edit.autosave.flushOnPageHide();
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(sent[0].keepalive).toBe(true);
		expect(sent[0].body.text).toBe('Typed, then the tab was closed.');
	});

	it('sends an edit too large for keepalive as an ordinary request', async () => {
		const edit = draftEdit(id(), stored);
		edit.text = 'x'.repeat(70 * 1024);
		edit.autosave.schedule();
		edit.autosave.flushOnPageHide();
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(sent[0].keepalive).toBe(false);
		// And the page asks before it is left while that edit is unsaved.
		const event = { preventDefault: vi.fn() } as unknown as Event;
		const other = draftEdit(id(), stored);
		other.text = 'unsaved';
		other.autosave.schedule();
		other.autosave.warnBeforeUnload(event);
		expect(event.preventDefault).toHaveBeenCalled();
	});

	it('does not send a blank draft, and says how to drop one', async () => {
		const edit = draftEdit(id(), stored);
		edit.text = '  \n';
		edit.autosave.schedule();
		await vi.advanceTimersByTimeAsync(5000);
		expect(sent).toEqual([]);
		expect(edit.error).toMatch(/Discard/);
		expect(edit.text).toBe('  \n');
		// Typing again saves as usual and clears the message.
		edit.text = 'Back.';
		edit.autosave.schedule();
		await vi.advanceTimersByTimeAsync(5000);
		expect(sent.map((s) => s.body.text)).toEqual(['Back.']);
		expect(edit.error).toBe('');
	});

	it('saves nothing more once the draft is decided', async () => {
		const key = id();
		const edit = draftEdit(key, stored);
		edit.text = 'Edited, then discarded.';
		edit.autosave.schedule();
		dropDraftEdit(key);
		await vi.advanceTimersByTimeAsync(5000);
		expect(sent).toEqual([]);
		// A later draft with the same id would start from what the server holds.
		expect(draftEdit(key, stored).text).toBe('As written.');
	});
});
