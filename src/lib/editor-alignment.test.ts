import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { alignmentPlan } from './editor-alignment';

function plan(doc: string, hideMarkers = false, activeLines: number[] = []) {
	const state = EditorState.create({ doc });
	return alignmentPlan(state, hideMarkers, new Set(activeLines));
}

describe('alignmentPlan', () => {
	it('aligns every line of a marked paragraph and reports the marker span', () => {
		const result = plan('\\center One\nTwo\n\nLeft para');
		expect(result.markers).toEqual([{ from: 0, to: 8, align: 'center', hidden: false }]);
		// Both lines of the centred paragraph are aligned; the left one is not.
		expect(result.lines.map((l) => l.align)).toEqual(['center', 'center']);
	});

	it('leaves the marker visible (not hidden) by default', () => {
		expect(plan('\\right Hi').markers[0].hidden).toBe(false);
	});

	it('hides the marker when hideMarkers is on and the line is not active', () => {
		expect(plan('\\right Hi', true).markers[0].hidden).toBe(true);
	});

	it('reveals the marker on an active line even when hiding', () => {
		// Line 1 carries the marker; mark it active.
		expect(plan('\\right Hi', true, [1]).markers[0].hidden).toBe(false);
	});

	it('finds no marker for a plain paragraph', () => {
		expect(plan('Just prose').markers).toEqual([]);
	});
});
