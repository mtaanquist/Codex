import { describe, expect, it, vi } from 'vitest';
import {
	CHAT_TITLE_MAX,
	chatTitle,
	newChatId,
	attachedHeader,
	attachmentKey,
	parseAttachedHeader,
	chatEffort,
	attachmentLabel,
	MAX_ATTACHMENTS,
	readAttachments,
	readChatSettings,
	withPrompt
} from './assistant-chat';

describe('chatTitle', () => {
	it('collapses whitespace', () => {
		expect(chatTitle('  Who is\n\nMarra   really? ')).toBe('Who is Marra really?');
	});

	it('cuts a long first message to fit a row', () => {
		const title = chatTitle('word '.repeat(40));
		expect(title.length).toBeLessThanOrEqual(CHAT_TITLE_MAX);
		expect(title.endsWith('...')).toBe(true);
		expect(title.startsWith('word word')).toBe(true);
	});

	it('keeps a message that already fits', () => {
		const text = 'x'.repeat(CHAT_TITLE_MAX);
		expect(chatTitle(text)).toBe(text);
	});
});

describe('newChatId', () => {
	it('makes a version 4 uuid, also where crypto.randomUUID is missing', () => {
		const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		expect(newChatId()).toMatch(shape);
		vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
		try {
			const made = newChatId();
			expect(made).toMatch(shape);
			expect(newChatId()).not.toBe(made);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('withPrompt', () => {
	it('puts the prompt in an empty box', () => {
		expect(withPrompt('  ', '', 'Check this.')).toBe('Check this.');
	});

	it('keeps typed text, with the prompt after it', () => {
		expect(withPrompt("Check Marra's age", '', 'A')).toBe("Check Marra's age\n\nA");
	});

	it('swaps an earlier prompt and keeps the text typed before it', () => {
		const first = withPrompt("Check Marra's age", '', 'A');
		expect(withPrompt(first, 'A', 'B')).toBe("Check Marra's age\n\nB");
	});

	it('replaces an earlier prompt left on its own', () => {
		expect(withPrompt('A', 'A', 'B')).toBe('B');
	});

	it('keeps an earlier prompt the writer added to', () => {
		expect(withPrompt('A and more', 'A', 'B')).toBe('A and more\n\nB');
	});

	it('replaces a half-typed command', () => {
		expect(withPrompt('/rec', '', 'B')).toBe('B');
	});
});

describe('readChatSettings', () => {
	it('keeps a model id and a known effort level', () => {
		expect(readChatSettings({ model: ' claude-opus-5 ', effort: 'high' })).toEqual({
			model: 'claude-opus-5',
			effort: 'high'
		});
	});

	it('drops anything else', () => {
		expect(readChatSettings(null)).toEqual({});
		expect(readChatSettings('x')).toEqual({});
		expect(readChatSettings({ model: '', effort: 'extreme' })).toEqual({});
		expect(readChatSettings({ model: 'x'.repeat(201) })).toEqual({});
		expect(readChatSettings({ model: 42 })).toEqual({});
	});
});

describe('readAttachments', () => {
	const id = '11111111-1111-4111-8111-111111111111';
	it('keeps well-formed attachments and gives a story a depth', () => {
		expect(
			readAttachments([
				{ kind: 'scene', id, label: ' The gate ' },
				{ kind: 'story', id, label: 'Ash' },
				{ kind: 'story', id, label: 'Ash', depth: 'book', shortened: true }
			])
		).toEqual([
			{ kind: 'scene', id, label: 'The gate' },
			{ kind: 'story', id, label: 'Ash', depth: 'outline' },
			{ kind: 'story', id, label: 'Ash', depth: 'book', shortened: true }
		]);
	});

	it('keeps the entry type on a library entry only, and only a known one', () => {
		const other = '22222222-2222-4222-8222-222222222222';
		const third = '33333333-3333-4333-8333-333333333333';
		expect(
			readAttachments([
				{ kind: 'entity', id, label: 'The Quay', entityType: 'place' },
				{ kind: 'entity', id: other, label: 'Mira', entityType: 'dragon' },
				{ kind: 'scene', id: third, label: 'The gate', entityType: 'lore' }
			])
		).toEqual([
			{ kind: 'entity', id, label: 'The Quay', entityType: 'place' },
			{ kind: 'entity', id: other, label: 'Mira' },
			{ kind: 'scene', id: third, label: 'The gate' }
		]);
	});

	it('drops malformed entries and duplicates, and caps the list', () => {
		expect(readAttachments('x')).toEqual([]);
		expect(
			readAttachments([
				{ kind: 'universe', id, label: 'U' },
				{ kind: 'scene', id: 'nope', label: 'S' },
				{ kind: 'scene', id, label: 'S' },
				{ kind: 'scene', id, label: 'S again' }
			])
		).toEqual([{ kind: 'scene', id, label: 'S' }]);
		const many = Array.from({ length: 12 }, (_, i) => ({
			kind: 'note',
			id: `11111111-1111-4111-8111-1111111111${String(i).padStart(2, '0')}`,
			label: 'N'
		}));
		expect(readAttachments(many)).toHaveLength(MAX_ATTACHMENTS);
	});
});

describe('attachmentLabel', () => {
	it('says what a story brings along', () => {
		const id = '11111111-1111-4111-8111-111111111111';
		expect(attachmentLabel({ kind: 'story', id, label: 'Ash', depth: 'book' })).toBe(
			'Ash (whole book)'
		);
		expect(attachmentLabel({ kind: 'story', id, label: 'Ash', depth: 'outline' })).toBe(
			'Ash (outline)'
		);
		expect(attachmentLabel({ kind: 'scene', id, label: '' })).toBe('Untitled');
	});
});

describe('attachmentKey', () => {
	it('tells a story outline from the whole book', () => {
		const id = '11111111-1111-4111-8111-111111111111';
		expect(attachmentKey({ kind: 'scene', id })).toBe(`scene:${id}`);
		expect(attachmentKey({ kind: 'story', id, depth: 'book' })).not.toBe(
			attachmentKey({ kind: 'story', id, depth: 'outline' })
		);
	});
});

describe('chatEffort', () => {
	const info = { model: 'claude-opus-5', effort: 'high' as const, claude: true };
	it("shows the account's effort on the account's model, and the default on another", () => {
		expect(chatEffort({}, info)).toBe('high');
		expect(chatEffort({ model: 'claude-sonnet-5' }, info)).toBe('medium');
		expect(chatEffort({ model: 'claude-sonnet-5', effort: 'low' }, info)).toBe('low');
	});
	it('shows none where the model takes none', () => {
		expect(chatEffort({ model: 'claude-haiku-4-5' }, info)).toBeNull();
		expect(chatEffort({}, { model: 'local', effort: null, claude: false })).toBeNull();
	});
});

describe('the sent-attachments header', () => {
	const id = '11111111-1111-4111-8111-111111111111';

	it('round-trips keys, the shortened mark and names with any punctuation', () => {
		const sent = [
			{
				kind: 'story' as const,
				id,
				depth: 'book' as const,
				label: 'Ash, Ember = Fire!',
				shortened: true
			},
			{ kind: 'scene' as const, id, label: 'Caf\u00e9 at night' }
		];
		const header = attachedHeader(sent).join(',');
		expect(header).toMatch(/^[\x20-\x7e]*$/);
		const parsed = parseAttachedHeader(header);
		expect(parsed.get(`story:${id}:book`)).toEqual({
			shortened: true,
			label: 'Ash, Ember = Fire!'
		});
		expect(parsed.get(`scene:${id}`)).toEqual({ shortened: false, label: 'Caf\u00e9 at night' });
	});

	it('reads an entry with no name, or one that does not decode, as no name', () => {
		const parsed = parseAttachedHeader(`scene:${id}!,note:${id}=%E0%A4%A`);
		expect(parsed.get(`scene:${id}`)).toEqual({ shortened: true });
		expect(parsed.get(`note:${id}`)).toEqual({ shortened: false });
	});
});
