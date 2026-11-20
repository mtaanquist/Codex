import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clampPaneWidth, PANE_BOUNDS, PANE_VALUE_RE, paneMax, paneWidthValue } from './pane-widths';

describe('pane widths', () => {
	it('never goes below the token floor', () => {
		expect(clampPaneWidth('left', 100, 1440)).toBe(264);
		expect(clampPaneWidth('right', 100, 1440)).toBe(312);
	});

	it('caps at a share of the window', () => {
		expect(paneMax('right', 1440)).toBe(576);
		expect(clampPaneWidth('right', 900, 1440)).toBe(576);
		expect(clampPaneWidth('left', 900, 1440)).toBe(432);
	});

	it('keeps the floor when the window is too small for the cap', () => {
		expect(paneMax('right', 600)).toBe(312);
		expect(clampPaneWidth('right', 400, 600)).toBe(312);
	});

	it('writes a value the pre-paint script accepts', () => {
		expect(paneWidthValue('right', 450.4)).toBe('clamp(312px, 450px, 40vw)');
		expect(PANE_VALUE_RE.test(paneWidthValue('left', 300))).toBe(true);
		expect(PANE_VALUE_RE.test('300px; background: red')).toBe(false);
	});

	it('matches the floors in tokens.css', () => {
		const tokens = readFileSync('src/lib/styles/tokens.css', 'utf8');
		expect(tokens).toContain(`--left-w: clamp(${PANE_BOUNDS.left.min}px,`);
		expect(tokens).toContain(`--right-w: clamp(${PANE_BOUNDS.right.min}px,`);
	});

	it('is restored by the pre-paint script with the same check and bounds', () => {
		const html = readFileSync('src/app.html', 'utf8');
		expect(html).toContain(PANE_VALUE_RE.source);
		const { left, right } = PANE_BOUNDS;
		expect(html).toContain(
			`{ left: [${left.min}, ${left.maxVw}], right: [${right.min}, ${right.maxVw}] }`
		);
	});
});
