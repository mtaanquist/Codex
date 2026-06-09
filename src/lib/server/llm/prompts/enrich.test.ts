import { describe, it, expect } from 'vitest';
import { buildEnrichMessage, type EnrichEntity } from './enrich';

function entity(over: Partial<EnrichEntity>): EnrichEntity {
	return {
		kind: 'character',
		name: 'Bram',
		aliases: [],
		details: [],
		summaryMd: null,
		hasSummary: false,
		...over
	};
}

describe('buildEnrichMessage', () => {
	it('names the entity, includes the passages, and asks for a JSON object', () => {
		const message = buildEnrichMessage(entity({ name: 'Bram' }), ['Bram drew his blade.']);
		expect(message).toContain('Bram');
		expect(message).toContain('Bram drew his blade.');
		expect(message).toMatch(/only a JSON object/i);
		expect(message).toContain('"aliases"');
		expect(message).toContain('"details"');
	});

	it('asks for a summary only when the entity has none', () => {
		expect(buildEnrichMessage(entity({ hasSummary: false }), [])).toMatch(
			/one or two sentence summary/i
		);
		const withSummary = buildEnrichMessage(
			entity({ hasSummary: true, summaryMd: 'A knight.' }),
			[]
		);
		expect(withSummary).toMatch(/do not propose a summary/i);
	});

	it('uses keywords rather than aliases for lore', () => {
		const message = buildEnrichMessage(entity({ kind: 'lore', name: 'The Aether' }), []);
		expect(message).toMatch(/keywords/i);
		expect(message).toContain('lore entry');
	});
});
