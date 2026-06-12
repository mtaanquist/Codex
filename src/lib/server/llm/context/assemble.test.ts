import { describe, it, expect } from 'vitest';
import {
	buildSystemMessage,
	estimateTokens,
	selectWithinBudget,
	type AssembledContext,
	type ContextTier
} from './assemble';

describe('estimateTokens', () => {
	it('approximates four characters per token', () => {
		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens('abcd')).toBe(1);
		expect(estimateTokens('abcde')).toBe(2);
	});
});

describe('selectWithinBudget', () => {
	const tier = (name: string, chars: number): ContextTier => ({ name, text: 'x'.repeat(chars) });

	it('includes every tier when the budget is ample', () => {
		const result = selectWithinBudget([tier('a', 40), tier('b', 40)], 1000);
		expect(result.includedTiers).toEqual(['a', 'b']);
		expect(result.droppedTiers).toEqual([]);
	});

	it('always keeps the first tier even if it alone exceeds the budget', () => {
		// Frame is first and tiny in practice; this guards the "used > 0" rule.
		const result = selectWithinBudget([tier('frame', 400)], 1);
		expect(result.includedTiers).toEqual(['frame']);
	});

	it('drops a tier that does not fit but keeps a later, smaller one', () => {
		// 4 chars/token: frame=1 token, big=25 tokens, small=1 token. Budget 3.
		const result = selectWithinBudget([tier('frame', 4), tier('big', 100), tier('small', 4)], 3);
		expect(result.includedTiers).toEqual(['frame', 'small']);
		expect(result.droppedTiers).toEqual(['big']);
	});

	it('skips empty tiers silently', () => {
		const result = selectWithinBudget([tier('frame', 4), { name: 'empty', text: '   ' }], 1000);
		expect(result.includedTiers).toEqual(['frame']);
		expect(result.droppedTiers).toEqual([]);
	});

	it('mentions the scene tools only on tool-capable turns', () => {
		const context: AssembledContext = {
			text: 'world context',
			estimatedTokens: 2,
			budgetTokens: 100,
			includedTiers: ['frame'],
			droppedTiers: [],
			establishedSetting: false,
			sources: { entities: [], scenes: [], lore: [] }
		};
		expect(buildSystemMessage(context).content).not.toContain('get_scene');
		const withTools = buildSystemMessage(context, { tools: true }).content;
		expect(withTools).toContain('get_scene');
		expect(withTools).toContain('list_scenes');
		expect(withTools).toContain('world context');
	});

	it('permits canon knowledge only for an established setting', () => {
		const context: AssembledContext = {
			text: 'world context',
			estimatedTokens: 2,
			budgetTokens: 100,
			includedTiers: ['frame'],
			droppedTiers: [],
			establishedSetting: false,
			sources: { entities: [], scenes: [], lore: [] }
		};
		expect(buildSystemMessage(context).content).not.toContain('published canon');
		const established = buildSystemMessage({ ...context, establishedSetting: true }).content;
		expect(established).toContain('published canon');
		expect(established).toContain('overrides');
		// The tool hint still rides along on tool-capable turns.
		expect(
			buildSystemMessage({ ...context, establishedSetting: true }, { tools: true }).content
		).toContain('get_scene');
	});

	it('joins included tiers with a blank line', () => {
		const result = selectWithinBudget(
			[
				{ name: 'a', text: 'one' },
				{ name: 'b', text: 'two' }
			],
			1000
		);
		expect(result.text).toBe('one\n\ntwo');
	});
});
