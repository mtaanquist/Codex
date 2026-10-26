import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS } from '$lib/appearance';
import {
	AA_TEXT,
	DARK_TEXT_CEILING,
	LIGHT_TEXT_FLOOR,
	accentFill,
	contrastRatio,
	mixWithBlack,
	relativeLuminance
} from '$lib/contrast';

// Holds the token values in tokens.css to WCAG AA so a palette tweak cannot
// quietly drop text below 4.5:1 in any theme.
const css = readFileSync(join(process.cwd(), 'src/lib/styles/tokens.css'), 'utf8');

function block(selector: string): Record<string, string> {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`${selector} not found in tokens.css`);
	const body = css.slice(start, css.indexOf('\n}', start));
	return Object.fromEntries(
		[...body.matchAll(/^\s*(--[\w-]+):\s*(.+);$/gm)].map((m) => [m[1], m[2].trim()])
	);
}

// A token as an opaque six-digit hex, failing loudly on anything else so a
// missing or non-hex value can never compare as a pass.
function hex(tokens: Record<string, string>, name: string): string {
	const value = tokens[name];
	if (!/^#[0-9a-f]{6}$/i.test(value ?? ''))
		throw new Error(`${name} is not a hex colour: ${value}`);
	return value;
}

const root = block(':root');
// A theme block inherits :root, so a token moved there is still checked.
const themes = ['light', 'warm', 'dark'].map((name) => ({
	name,
	tokens: { ...root, ...block(`[data-theme='${name}']`) }
}));
const SURFACES = ['--bg', '--bg-elevated', '--bg-panel', '--bg-card', '--bg-canvas'];
const MIX = 'color-mix(in oklab, var(--accent) 75%, black)';

describe('token contrast', () => {
	it('derives the accent fill with the mix contrast.ts mirrors', () => {
		expect(root['--accent-fill']).toBe(MIX);
		expect(root['--accent-contrast']).toBe('#ffffff');
	});

	it('gives white text AA on every preset accent fill', () => {
		for (const { name, value } of ACCENT_PRESETS) {
			expect(contrastRatio('#ffffff', accentFill(value)), name).toBeGreaterThanOrEqual(AA_TEXT);
		}
	});

	it('warns about custom accents against the hardest surfaces', () => {
		const lum = (theme: string) =>
			SURFACES.map((s) => relativeLuminance(hex(themes.find((t) => t.name === theme)!.tokens, s)));
		const lightFloor = Math.min(...lum('light'), ...lum('warm'));
		const darkCeiling = Math.max(...lum('dark'));
		expect(relativeLuminance(LIGHT_TEXT_FLOOR)).toBeCloseTo(lightFloor, 10);
		expect(relativeLuminance(DARK_TEXT_CEILING)).toBeCloseTo(darkCeiling, 10);
	});

	for (const { name, tokens } of themes) {
		describe(name, () => {
			const surfaces = SURFACES.map((s) => [s, hex(tokens, s)] as const);

			it('keeps every text tier at AA on every solid surface', () => {
				for (const tier of ['--text', '--text-muted', '--text-faint']) {
					for (const [surface, bg] of surfaces) {
						expect(
							contrastRatio(hex(tokens, tier), bg),
							`${tier} on ${surface}`
						).toBeGreaterThanOrEqual(AA_TEXT);
					}
				}
			});

			it('keeps three distinct text tiers', () => {
				const ratios = ['--text', '--text-muted', '--text-faint'].map((t) =>
					contrastRatio(hex(tokens, t), hex(tokens, '--bg'))
				);
				expect(ratios[0]).toBeGreaterThan(ratios[1]);
				expect(ratios[1]).toBeGreaterThan(ratios[2]);
			});

			it('draws the select caret in the faint colour', () => {
				expect(tokens['--select-caret']).toContain(`%23${tokens['--text-faint'].slice(1)}`);
			});

			it('keeps preset accent text at AA', () => {
				const darkened = tokens['--accent-ink'] === MIX;
				expect(darkened || tokens['--accent-ink'] === 'var(--accent)').toBe(true);
				for (const { name: preset, value } of ACCENT_PRESETS) {
					const ink = darkened ? accentFill(value) : value;
					for (const [surface, bg] of surfaces) {
						expect(contrastRatio(ink, bg), `${preset} on ${surface}`).toBeGreaterThanOrEqual(
							AA_TEXT
						);
					}
				}
			});

			it('gives white text AA on the danger fill', () => {
				const danger = hex(tokens, '--danger');
				const fill = tokens['--danger-fill'];
				const shade =
					fill === 'var(--danger)'
						? danger
						: fill === 'color-mix(in oklab, var(--danger) 75%, black)'
							? mixWithBlack(danger, 0.75)
							: null;
				expect(shade, `unexpected --danger-fill: ${fill}`).not.toBeNull();
				expect(contrastRatio('#ffffff', shade!)).toBeGreaterThanOrEqual(AA_TEXT);
			});

			it('keeps the accept text at AA', () => {
				const ink =
					tokens['--status-final-ink'] === 'var(--status-final)'
						? hex(tokens, '--status-final')
						: hex(tokens, '--status-final-ink');
				for (const [surface, bg] of surfaces) {
					expect(contrastRatio(ink, bg), surface).toBeGreaterThanOrEqual(AA_TEXT);
				}
			});
		});
	}
});
