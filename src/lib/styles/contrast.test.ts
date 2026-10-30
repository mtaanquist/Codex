import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS } from '#lib/appearance';
import {
	AA_TEXT,
	DARK_TEXT_CEILING,
	LIGHT_TEXT_FLOOR,
	accentFill,
	contrastRatio,
	mixWithBlack,
	relativeLuminance
} from '#lib/contrast';

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
const CATS = Object.keys(themes[0].tokens).filter((t) => t.startsWith('--cat-'));
// The share review avatars, the focused margin marker and entity badge
// letters keep when darkening a palette colour under white text. Checked against the two places it is
// written, so a change to either is a change here too.
const AUTHOR_FILL_SHARE = 65;
// The strongest author tint behind author-coloured text (suggested edits;
// comments tint ordinary text and are not bound by it).
const MAX_MARK_TINT = 15;

// A share of one colour laid over another (an sRGB blend, as the browser
// composites a transparent tint).
function blend(top: string, bottom: string, share: number): string {
	const channels = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
	const a = channels(top);
	const b = channels(bottom);
	return (
		'#' +
		a
			.map((v, i) => Math.round(v * share + b[i] * (1 - share)))
			.map((v) => v.toString(16).padStart(2, '0'))
			.join('')
	);
}

// Raw colour tokens that miss AA as text in some theme. Text takes the -ink
// twin (or, for a per-element colour, the --ink-share mix) instead.
// Matches a CSS declaration and a Svelte style:color directive.
const RAW_TEXT =
	/(?<![-\w])(color:\s*|style:color=["{]?['"]?)var\(--(accent|danger|status-[a-z]+|cat-[a-z]+|auth)\)/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.(css|svelte)$/.test(entry.name) ? [path] : [];
	});
}

describe('token contrast', () => {
	it('never uses a raw status, danger, accent or author colour as text', () => {
		const offenders = sourceFiles(join(process.cwd(), 'src')).flatMap((file) =>
			readFileSync(file, 'utf8')
				.split('\n')
				.map((line, index) => ({ line, index }))
				.filter(({ line }) => RAW_TEXT.test(line))
				.map(({ index }) => `${file.slice(process.cwd().length + 1)}:${index + 1}`)
		);
		expect(offenders).toEqual([]);
	});

	it('catches a raw colour set with a style directive', () => {
		expect(RAW_TEXT.test('<span style:color="var(--danger)">')).toBe(true);
		expect(RAW_TEXT.test("<span style:color={'var(--cat-red)'}>")).toBe(true);
		expect(RAW_TEXT.test('color: var(--danger-ink);')).toBe(false);
	});

	it('uses one author fill share wherever white sits on an author colour', () => {
		const avatar = readFileSync(
			join(process.cwd(), 'src/lib/components/ReviewAvatar.svelte'),
			'utf8'
		);
		const review = readFileSync(join(process.cwd(), 'src/lib/styles/review.css'), 'utf8');
		expect(avatar).toContain(`${AUTHOR_FILL_SHARE}%, black)`);
		expect(review).toContain(`var(--auth) ${AUTHOR_FILL_SHARE}%, black)`);
		// Entity badge letters take the same darkened fill.
		const badge = readFileSync(join(process.cwd(), 'src/lib/entity-badge.ts'), 'utf8');
		expect(badge).toContain(`\${color} ${AUTHOR_FILL_SHARE}%, black)`);
		expect(CATS.length).toBeGreaterThan(0);
	});

	it('keeps every author tint behind suggested text at or under the checked share', () => {
		const review = readFileSync(join(process.cwd(), 'src/lib/styles/review.css'), 'utf8');
		const shares = [...review.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
			.filter(([, selector]) => !selector.includes('rv-comment'))
			.flatMap(([, , body]) => [
				...body.matchAll(/background: color-mix\(in oklab, var\(--auth\) (\d+)%, transparent\)/g)
			])
			.map(([, share]) => Number(share));
		expect(shares.length).toBeGreaterThan(0);
		for (const share of shares) expect(share).toBeLessThanOrEqual(MAX_MARK_TINT);
	});

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

			// Status and danger colours used as text go through their -ink twin,
			// the plain token where it already reads, a darker hex where not.
			it('keeps status and danger text at AA', () => {
				for (const base of ['--status-final', '--status-draft', '--status-revised', '--danger']) {
					const value = tokens[`${base}-ink`];
					const ink = value === `var(${base})` ? hex(tokens, base) : hex(tokens, `${base}-ink`);
					for (const [surface, bg] of surfaces) {
						expect(contrastRatio(ink, bg), `${base}-ink on ${surface}`).toBeGreaterThanOrEqual(
							AA_TEXT
						);
					}
				}
			});

			// Review marks set --auth per author and darken it for text by
			// --ink-share (review.css); the owner's --auth is the raw accent, so
			// the share must match the accent text mix.
			it('keeps every author colour at AA as text', () => {
				const share = tokens['--ink-share'];
				expect(share).toBe(tokens['--accent-ink'] === MIX ? '75%' : '100%');
				const factor = parseFloat(share) / 100;
				for (const cat of CATS) {
					const ink = mixWithBlack(hex(tokens, cat), factor);
					for (const [surface, bg] of surfaces) {
						expect(contrastRatio(ink, bg), `${cat} on ${surface}`).toBeGreaterThanOrEqual(AA_TEXT);
					}
				}
			});

			// Marks tint their background with the author colour; the
			// strongest tint (hover and the focus pulse) must still carry
			// the darkened author text.
			it('keeps author text at AA on the strongest mark tint', () => {
				const factor = parseFloat(tokens['--ink-share']) / 100;
				for (const cat of CATS) {
					const ink = mixWithBlack(hex(tokens, cat), factor);
					for (const [surface, bg] of surfaces) {
						const tinted = blend(hex(tokens, cat), bg, MAX_MARK_TINT / 100);
						expect(contrastRatio(ink, tinted), `${cat} on ${surface}`).toBeGreaterThanOrEqual(
							AA_TEXT
						);
					}
				}
			});

			it('gives white initials AA on every author fill', () => {
				for (const cat of CATS) {
					const fill = mixWithBlack(hex(tokens, cat), AUTHOR_FILL_SHARE / 100);
					expect(contrastRatio('#ffffff', fill), cat).toBeGreaterThanOrEqual(AA_TEXT);
				}
			});
		});
	}
});
