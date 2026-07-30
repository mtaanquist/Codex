import { describe, expect, it } from 'vitest';
import { activePanel, PANEL_ORDER, visiblePanels } from './panels';

describe('visiblePanels', () => {
	it('keeps the one order whatever order the subjects arrive in', () => {
		const panels = visiblePanels({ notes: true, reference: true, history: true, assistant: true });
		expect(panels.map((panel) => panel.id)).toEqual(['reference', 'assistant', 'history', 'notes']);
	});

	it('hides a panel with no subject rather than disabling it', () => {
		const panels = visiblePanels({ reference: true, assistant: false, history: true });
		expect(panels.map((panel) => panel.id)).toEqual(['reference', 'history']);
	});

	it('treats an absent key as no subject', () => {
		expect(visiblePanels({}).length).toBe(0);
	});

	it('labels every panel the same way on every page', () => {
		const labels = visiblePanels(Object.fromEntries(PANEL_ORDER.map((id) => [id, true]))).map(
			(panel) => panel.label
		);
		expect(labels).toEqual(['Reference', 'Comments', 'Assistant', 'History', 'Notes']);
	});

	it('carries a count, and still shows the panel when the count is zero', () => {
		const panels = visiblePanels({ notes: 0, comments: 3 });
		expect(panels.map((panel) => [panel.id, panel.count])).toEqual([
			['comments', 3],
			['notes', 0]
		]);
	});

	it('reads the review strip as two wide', () => {
		const panels = visiblePanels({ comments: 16, assistant: true });
		expect(panels.map((panel) => panel.id)).toEqual(['comments', 'assistant']);
	});
});

describe('activePanel', () => {
	it('keeps the panel the viewer picked', () => {
		const panels = visiblePanels({ reference: true, history: true });
		expect(activePanel(panels, 'history')).toBe('history');
	});

	it('falls back to the first panel when the pick lost its subject', () => {
		const panels = visiblePanels({ reference: true, assistant: true });
		expect(activePanel(panels, 'history')).toBe('reference');
	});

	it('is null when nothing has a subject, which closes the pane', () => {
		expect(activePanel([], 'reference')).toBeNull();
	});
});
