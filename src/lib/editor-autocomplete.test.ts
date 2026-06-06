import { describe, it, expect } from 'vitest';
import { completionCandidates, completionEntries, ghostMatch } from './editor-autocomplete';
import type { MentionEntity } from './editor-mentions';

const entities: MentionEntity[] = [
	{
		id: '1',
		type: 'character' as const,
		name: 'Alice Vane',
		aliases: ['Allie', 'Mrs. Fenwick'],
		summaryMd: null
	},
	{ id: '2', type: 'character' as const, name: 'Bram', aliases: [], summaryMd: null },
	{ id: '3', type: 'place' as const, name: 'Halden', aliases: [], summaryMd: null },
	{ id: '4', type: 'place' as const, name: 'Halden Gate', aliases: [], summaryMd: null }
];

describe('completionCandidates', () => {
	it('matches names and aliases by case-insensitive prefix', () => {
		expect(completionCandidates(entities, 'al')).toEqual(['Alice Vane', 'Allie']);
		expect(completionCandidates(entities, 'Mrs')).toEqual(['Mrs. Fenwick']);
	});

	it('requires two characters', () => {
		expect(completionCandidates(entities, 'A')).toEqual([]);
	});

	it('stops offering a name once fully typed', () => {
		expect(completionCandidates(entities, 'Bram')).toEqual([]);
		// A longer name with the same start is still offered.
		expect(completionCandidates(entities, 'Halden')).toEqual(['Halden Gate']);
	});

	it('matches multi-word names across the space', () => {
		expect(completionCandidates(entities, 'Alice V')).toEqual(['Alice Vane']);
	});

	it('deduplicates names shared between entities', () => {
		const twins: MentionEntity[] = [
			{ id: 'a', type: 'character' as const, name: 'Asha', aliases: [], summaryMd: null },
			{ id: 'b', type: 'character' as const, name: 'asha', aliases: [], summaryMd: null }
		];
		expect(completionCandidates(twins, 'as')).toEqual(['Asha']);
	});
});

describe('completionEntries', () => {
	it('carries the entity behind each name', () => {
		const entries = completionEntries(entities, 'al');
		expect(entries.map((entry) => [entry.label, entry.entity.id])).toEqual([
			['Alice Vane', '1'],
			['Allie', '1']
		]);
	});

	it('offers a shared name once per entity, not once overall', () => {
		const twins: MentionEntity[] = [
			{ id: 'a', type: 'character' as const, name: 'Ashreach', aliases: [], summaryMd: null },
			{ id: 'b', type: 'lore_entry' as const, name: 'Ashreach', aliases: [], summaryMd: null }
		];
		expect(completionEntries(twins, 'as').map((entry) => entry.entity.id)).toEqual(['a', 'b']);
	});

	it('deduplicates within one entity when an alias repeats the name', () => {
		const echo: MentionEntity[] = [
			{ id: 'a', type: 'character' as const, name: 'Bram', aliases: ['bram '], summaryMd: null }
		];
		expect(completionEntries(echo, 'br')).toHaveLength(1);
	});

	it('requires two characters and drops fully typed names', () => {
		expect(completionEntries(entities, 'A')).toEqual([]);
		expect(completionEntries(entities, 'Bram')).toEqual([]);
	});
});

describe('ghostMatch', () => {
	it('completes an unambiguous prefix', () => {
		expect(ghostMatch(entities, 'She saw Mrs')).toEqual({
			prefix: 'Mrs',
			remainder: '. Fenwick'
		});
	});

	it('returns nothing when more than one name matches', () => {
		// "Al" matches Alice Vane and Allie.
		expect(ghostMatch(entities, 'She saw Al')).toBeNull();
		// "Halden" is both complete and the start of Halden Gate, so typing
		// it offers the longer name.
		expect(ghostMatch(entities, 'near Halden')).toEqual({
			prefix: 'Halden',
			remainder: ' Gate'
		});
	});

	it('extends across spaces in multi-word names', () => {
		expect(ghostMatch(entities, 'She saw Alice V')).toEqual({
			prefix: 'Alice V',
			remainder: 'ane'
		});
	});

	it('ignores short prefixes and unrelated text', () => {
		expect(ghostMatch(entities, 'B')).toBeNull();
		expect(ghostMatch(entities, 'nothing here matches')).toBeNull();
	});

	it('prefers the longest matching tail', () => {
		// "Vane" alone matches nothing; the full "Alice Va" wins.
		expect(ghostMatch(entities, 'Alice Va')).toEqual({
			prefix: 'Alice Va',
			remainder: 'ne'
		});
	});
});
