// Print and PDF page setup: the values that parameterize the one print
// stylesheet shared by the browser print route and the worker's PDF
// renderer. Pure data and builders only, imported by the worker, so no
// $lib aliases and no server imports here.

import type { Alignment } from './alignment.ts';

export type PageSize = 'a4' | 'letter' | '5x8' | '5.5x8.5' | '6x9';
export type PageMargins = 'narrow' | 'normal' | 'wide';
// 'default' renders Georgia in print and the editor's own content font on
// screen, so an untouched setup changes neither surface. 'custom' takes the
// family named in `fontCustom`, falling back to the default stack.
export type PageFont = 'default' | 'georgia' | 'times' | 'sans' | 'custom';
export type ParagraphStyle = 'indent' | 'spaced';
// 'custom' uses `lineSpacingCm` (a physical length) instead of a multiplier.
export type LineSpacing = 'single' | 'normal' | 'relaxed' | 'double' | 'custom';
// The extra binding margin on the inner (spine) edge, alternating per page.
export type Gutter = 'none' | 'narrow' | 'wide';

export type PageSetup = {
	pageSize: PageSize;
	margins: PageMargins;
	font: PageFont;
	// The family used when `font` is 'custom'; an empty string otherwise.
	fontCustom: string;
	// Body size in points.
	fontSize: number;
	paragraphStyle: ParagraphStyle;
	lineSpacing: LineSpacing;
	// Line height in centimetres, used only when `lineSpacing` is 'custom'.
	lineSpacingCm: number;
	// The alignment of paragraphs without a per-paragraph marker (\center,
	// \right, \justify). Marked paragraphs still override it.
	textAlign: Alignment;
	// Extra inner-margin for the spine; print and PDF only.
	gutter: Gutter;
	// The text printed between scenes; blank means a plain gap.
	sceneBreak: string;
	// PDF only: browsers control their own print headers and footers.
	pageNumbers: boolean;
	runningHeader: boolean;
};

// Today's output, so an untouched setup changes nothing.
export const DEFAULT_PAGE_SETUP: PageSetup = {
	pageSize: 'a4',
	margins: 'normal',
	font: 'default',
	fontCustom: '',
	fontSize: 12,
	paragraphStyle: 'indent',
	lineSpacing: 'normal',
	lineSpacingCm: 0.7,
	textAlign: 'left',
	gutter: 'none',
	sceneBreak: '* * *',
	pageNumbers: false,
	runningHeader: false
};

// The allowed range for a custom line height in centimetres.
export const LINE_SPACING_CM_MIN = 0.3;
export const LINE_SPACING_CM_MAX = 2;

// `css` is the @page size keyword/dimensions; `width` is the physical page
// width as a CSS length, used to size the in-app preview's text column.
export const PAGE_SIZES: Record<PageSize, { label: string; css: string; width: string }> = {
	a4: { label: 'A4', css: 'A4', width: '210mm' },
	letter: { label: 'US Letter', css: 'letter', width: '8.5in' },
	'5x8': { label: '5 x 8 in (trade)', css: '5in 8in', width: '5in' },
	'5.5x8.5': { label: '5.5 x 8.5 in (digest)', css: '5.5in 8.5in', width: '5.5in' },
	'6x9': { label: '6 x 9 in (trade)', css: '6in 9in', width: '6in' }
};

export const PAGE_MARGINS: Record<PageMargins, { label: string; css: string }> = {
	narrow: { label: 'Narrow (1.3 cm)', css: '1.3cm' },
	normal: { label: 'Normal (2 cm)', css: '2cm' },
	wide: { label: 'Wide (2.8 cm)', css: '2.8cm' }
};

// The default stack, also the fallback appended after a custom family.
const DEFAULT_FONT_CSS = "Georgia, 'Times New Roman', serif";

export const PAGE_FONTS: Record<PageFont, { label: string; css: string }> = {
	default: { label: 'Default', css: DEFAULT_FONT_CSS },
	georgia: { label: 'Georgia (serif)', css: DEFAULT_FONT_CSS },
	times: { label: 'Times (serif)', css: "'Times New Roman', 'Liberation Serif', serif" },
	sans: { label: 'Sans serif', css: "Arial, 'Liberation Sans', sans-serif" },
	custom: { label: 'Custom font...', css: DEFAULT_FONT_CSS }
};

export const LINE_SPACINGS: Record<LineSpacing, { label: string; lineHeight: number }> = {
	single: { label: 'Single', lineHeight: 1.25 },
	normal: { label: 'Normal', lineHeight: 1.6 },
	relaxed: { label: 'Relaxed', lineHeight: 1.85 },
	double: { label: 'Double', lineHeight: 2.1 },
	custom: { label: 'Custom (cm)', lineHeight: 1.6 }
};

export const TEXT_ALIGNS: Record<Alignment, { label: string }> = {
	left: { label: 'Left' },
	center: { label: 'Center' },
	right: { label: 'Right' },
	justify: { label: 'Justified' }
};

// The inner (spine) binding margin, added on top of the page margin. Print and
// PDF only; an untouched 'none' leaves output exactly as before.
export const GUTTERS: Record<Gutter, { label: string; css: string }> = {
	none: { label: 'None', css: '0cm' },
	narrow: { label: 'Narrow (0.5 cm)', css: '0.5cm' },
	wide: { label: 'Wide (1 cm)', css: '1cm' }
};

export const FONT_SIZES = [10, 11, 12, 13, 14] as const;
const MAX_SCENE_BREAK = 20;
const MAX_FONT_NAME = 50;
// Family names are letters, digits, spaces and hyphens; anything else is
// dropped so the value is always safe to drop into a CSS string.
const FONT_NAME_DISALLOWED = /[^a-zA-Z0-9 -]/g;

function isKey<T extends string>(record: Record<T, unknown>, value: unknown): value is T {
	return typeof value === 'string' && value in record;
}

export function isPageFont(value: unknown): value is PageFont {
	return isKey(PAGE_FONTS, value);
}

export function isLineSpacing(value: unknown): value is LineSpacing {
	return isKey(LINE_SPACINGS, value);
}

// Reused by the editor-appearance preferences, which store the same kind of
// font name and custom line height as page setup.
export function sanitiseFontName(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	return raw.replace(FONT_NAME_DISALLOWED, '').replace(/\s+/g, ' ').trim().slice(0, MAX_FONT_NAME);
}

export function clampLineSpacingCm(raw: unknown): number {
	const value = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(value)) return DEFAULT_PAGE_SETUP.lineSpacingCm;
	return Math.min(
		LINE_SPACING_CM_MAX,
		Math.max(LINE_SPACING_CM_MIN, Math.round(value * 100) / 100)
	);
}

function isAlignment(value: unknown): value is Alignment {
	return value === 'left' || value === 'center' || value === 'right' || value === 'justify';
}

// Defaults applied to whatever is stored; unknown values fall back rather
// than break output when an option is renamed.
export function normalisePageSetup(raw: Record<string, unknown>): PageSetup {
	return {
		pageSize: isKey(PAGE_SIZES, raw.pageSize) ? raw.pageSize : DEFAULT_PAGE_SETUP.pageSize,
		margins: isKey(PAGE_MARGINS, raw.margins) ? raw.margins : DEFAULT_PAGE_SETUP.margins,
		font: isKey(PAGE_FONTS, raw.font) ? raw.font : DEFAULT_PAGE_SETUP.font,
		fontCustom: sanitiseFontName(raw.fontCustom),
		fontSize: FONT_SIZES.includes(raw.fontSize as (typeof FONT_SIZES)[number])
			? (raw.fontSize as number)
			: DEFAULT_PAGE_SETUP.fontSize,
		paragraphStyle: raw.paragraphStyle === 'spaced' ? 'spaced' : DEFAULT_PAGE_SETUP.paragraphStyle,
		lineSpacing: isKey(LINE_SPACINGS, raw.lineSpacing)
			? raw.lineSpacing
			: DEFAULT_PAGE_SETUP.lineSpacing,
		lineSpacingCm: clampLineSpacingCm(raw.lineSpacingCm),
		textAlign: isAlignment(raw.textAlign) ? raw.textAlign : DEFAULT_PAGE_SETUP.textAlign,
		gutter: isKey(GUTTERS, raw.gutter) ? raw.gutter : DEFAULT_PAGE_SETUP.gutter,
		sceneBreak:
			typeof raw.sceneBreak === 'string'
				? raw.sceneBreak.trim().slice(0, MAX_SCENE_BREAK)
				: DEFAULT_PAGE_SETUP.sceneBreak,
		pageNumbers: raw.pageNumbers === true,
		runningHeader: raw.runningHeader === true
	};
}

// The story's effective setup: the account's defaults with the story's
// overrides on top.
export function mergePageSetup(
	userRaw: Record<string, unknown>,
	storyRaw: Record<string, unknown>
): PageSetup {
	return normalisePageSetup({ ...userRaw, ...storyRaw });
}

// Escapes a user value for a CSS string literal. The '<' is escaped as a CSS
// hex escape so the value can never form a literal '</style>' that would close
// the surrounding style element in the print HTML or EPUB XHTML.
export function cssEscape(text: string): string {
	return text
		.replaceAll('\\', '\\\\')
		.replaceAll("'", "\\'")
		.replaceAll('\n', ' ')
		.replaceAll('<', '\\3c ');
}

// The parameterized print stylesheet: page geometry, typography, scene
// breaks, and explicit page breaks. The PDF renderer passes the page
// geometry through pdf options instead (Chromium's header/footer layer
// needs it there), so @page is optional.

// The CSS line-height for a font/spacing pair, shared by every surface (and
// the editor) so they never drift: a unitless multiplier for the presets, or
// a physical length for a custom value.
export function lineHeightFor(lineSpacing: LineSpacing, lineSpacingCm: number): string {
	if (lineSpacing === 'custom') return `${lineSpacingCm}cm`;
	return String(LINE_SPACINGS[lineSpacing].lineHeight);
}

export function lineHeightCss(setup: PageSetup): string {
	return lineHeightFor(setup.lineSpacing, setup.lineSpacingCm);
}

// The CSS font-family for a font choice. A custom family is quoted and
// followed by the default stack, so an unknown family simply falls back to
// the default.
export function fontFamilyFor(font: PageFont, fontCustom: string): string {
	if (font === 'custom' && fontCustom) {
		return `'${cssEscape(fontCustom)}', ${PAGE_FONTS.custom.css}`;
	}
	return PAGE_FONTS[font].css;
}

export function fontFamilyCss(setup: PageSetup): string {
	return fontFamilyFor(setup.font, setup.fontCustom);
}

// The text-column width of a single page: page width less both side margins
// (the inner side carries the gutter). Used to size the in-app preview faithfully.
export function contentWidthCss(setup: PageSetup): string {
	const width = PAGE_SIZES[setup.pageSize].width;
	const margin = PAGE_MARGINS[setup.margins].css;
	const gutter = GUTTERS[setup.gutter].css;
	return `calc(${width} - 2 * ${margin} - ${gutter})`;
}

// The @page rule(s). With a gutter, the inner (spine) margin alternates: the
// left margin on right-hand pages, the right margin on left-hand pages. Shared
// by pageCss (PDF) and the browser print route so the two never drift.
export function pageRuleCss(setup: PageSetup): string {
	const size = PAGE_SIZES[setup.pageSize].css;
	const margin = PAGE_MARGINS[setup.margins].css;
	if (setup.gutter === 'none') return `@page { size: ${size}; margin: ${margin}; }`;
	const inner = `calc(${margin} + ${GUTTERS[setup.gutter].css})`;
	return `@page { size: ${size}; }
@page :right { margin: ${margin} ${margin} ${margin} ${inner}; }
@page :left { margin: ${margin} ${inner} ${margin} ${margin}; }`;
}

export function pageCss(setup: PageSetup, options: { includePageRule?: boolean } = {}): string {
	const paragraph =
		setup.paragraphStyle === 'indent'
			? 'margin: 0 0 0.2rem; text-indent: 1.5em;'
			: 'margin: 0 0 0.8em; text-indent: 0;';
	const sceneBreak = setup.sceneBreak
		? `content: '${cssEscape(setup.sceneBreak)}'; color: #444;`
		: "content: '';";
	const pageRule = options.includePageRule === false ? '' : `\n${pageRuleCss(setup)}`;
	return `body { font-family: ${fontFamilyCss(setup)}; font-size: ${setup.fontSize}pt; line-height: ${lineHeightCss(setup)}; color: #000; margin: 0; }
.title-page { text-align: center; margin: 4rem 0 6rem; page-break-after: always; }
.title-page h1 { font-size: 28pt; font-weight: 600; }
.author { margin-top: 1rem; font-size: 14pt; }
.chapter { page-break-before: always; }
.chapter h2 { text-align: center; font-size: 18pt; margin: 3rem 0 2rem; }
.scene-break { border: 0; text-align: center; margin: 2rem 0; }
.scene-break::after { ${sceneBreak} }
.chapter p { text-align: ${setup.textAlign}; ${paragraph} }
.chapter p.align-center { text-align: center; text-indent: 0; }
.chapter p.align-right { text-align: right; text-indent: 0; }
.chapter p.align-justify { text-align: justify; }
.page-break { page-break-after: always; }
img { max-width: 100%; }${pageRule}`;
}

// Options for Chromium's pdf() call: the page geometry, and when page
// numbers or a running header are on, the header/footer layer that draws
// them.
export function pdfRenderOptions(setup: PageSetup, title: string): Record<string, unknown> {
	const size = setup.pageSize;
	const geometry =
		size === 'a4' || size === 'letter'
			? { format: size === 'a4' ? 'a4' : 'letter' }
			: size === '5x8'
				? { width: '5in', height: '8in' }
				: size === '5.5x8.5'
					? { width: '5.5in', height: '8.5in' }
					: { width: '6in', height: '9in' };
	const chrome = setup.pageNumbers || setup.runningHeader;
	return {
		...geometry,
		// Margins come from the embedded @page CSS so the spine gutter can
		// alternate per page; the header/footer layer still finds its room.
		preferCSSPageSize: true,
		...(chrome
			? {
					displayHeaderFooter: true,
					headerTemplate: setup.runningHeader
						? `<div style="font-size: 9pt; width: 100%; text-align: center; font-family: serif;">${escapeHtml(title)}</div>`
						: '<span></span>',
					footerTemplate: setup.pageNumbers
						? '<div style="font-size: 9pt; width: 100%; text-align: center; font-family: serif;"><span class="pageNumber"></span></div>'
						: '<span></span>'
				}
			: {})
	};
}

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}
