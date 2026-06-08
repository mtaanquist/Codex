import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { indentPlan } from './editor-indent';

function plan(doc: string, hideMarkers = false, activeLines: number[] = []) {
	const state = EditorState.create({ doc });
	return indentPlan(state, hideMarkers, new Set(activeLines));
}

describe('indentPlan', () => {
	it('indents every line of a marked paragraph and reports the marker span', () => {
		const result = plan('\\indent2 One\nTwo\n\nPlain');
		expect(result.markers).toEqual([{ from: 0, to: 9, hidden: false }]);
		expect(result.lines.map((l) => l.level)).toEqual([2, 2]);
	});

	it('locates the indent marker after an alignment marker', () => {
		const result = plan('\\center \\indent Hi');
		// The marker span starts past the 8-char "\center " prefix.
		expect(result.markers[0].from).toBe(8);
		expect(result.lines[0].level).toBe(1);
	});

	it('hides the marker when hiding is on and the line is inactive, reveals when active', () => {
		expect(plan('\\indent Hi', true).markers[0].hidden).toBe(true);
		expect(plan('\\indent Hi', true, [1]).markers[0].hidden).toBe(false);
	});

	it('finds nothing for a plain paragraph', () => {
		expect(plan('Just prose').markers).toEqual([]);
		expect(plan('Just prose').lines).toEqual([]);
	});
});
