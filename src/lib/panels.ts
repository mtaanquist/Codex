// The right pane's panels. The left strip is routes and never changes shape;
// the right strip is panels about whatever the centre holds, so it changes with
// the mode. There are five panels, one order, and one label each. A panel with
// no subject is hidden - never disabled, never renamed - because a subject is
// not something a viewer can grant themselves.

export type PanelId = 'reference' | 'comments' | 'assistant' | 'history' | 'notes';

export const PANEL_ORDER: PanelId[] = ['reference', 'comments', 'assistant', 'history', 'notes'];

export const PANEL_LABELS: Record<PanelId, string> = {
	reference: 'Reference',
	comments: 'Comments',
	assistant: 'Assistant',
	history: 'History',
	notes: 'Notes'
};

export type Panel = {
	id: PanelId;
	label: string;
	// A tally riding in the tab, such as the open comments in this scene.
	count?: number;
};

/**
 * The panels to show, in the one fixed order, given which ones have a subject
 * on this page. A count may be given instead of true; zero still counts as
 * having a subject (an empty History is a real, if short, history).
 */
export function visiblePanels(subjects: Partial<Record<PanelId, boolean | number>>): Panel[] {
	const panels: Panel[] = [];
	for (const id of PANEL_ORDER) {
		const subject = subjects[id];
		if (subject === undefined || subject === false) continue;
		panels.push(
			typeof subject === 'number'
				? { id, label: PANEL_LABELS[id], count: subject }
				: { id, label: PANEL_LABELS[id] }
		);
	}
	return panels;
}

/**
 * The panel to show: the one the viewer picked if it still has a subject,
 * otherwise the first that has one. Null when the pane has nothing to show,
 * which is the signal to close the pane entirely.
 */
export function activePanel(panels: Panel[], preferred: PanelId | null): PanelId | null {
	if (preferred && panels.some((panel) => panel.id === preferred)) return preferred;
	return panels[0]?.id ?? null;
}

// The DOM ids that tie a tab to its panel. One place, so aria-controls and
// aria-labelledby cannot drift apart.
export function tabDomId(id: PanelId): string {
	return `panel-tab-${id}`;
}

export function panelDomId(id: PanelId): string {
	return `panel-body-${id}`;
}
