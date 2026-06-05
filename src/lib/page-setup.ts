// Print and PDF page setup: the values that parameterize the one print
// stylesheet shared by the browser print route and the worker's PDF
// renderer. Pure data and builders only, imported by the worker, so no
// $lib aliases and no server imports here.

export type PageSize = 'a4' | 'letter' | '5x8' | '5.5x8.5' | '6x9';
export type PageMargins = 'narrow' | 'normal' | 'wide';
export type PageFont = 'georgia' | 'times' | 'sans';
export type ParagraphStyle = 'indent' | 'spaced';

export type PageSetup = {
	pageSize: PageSize;
	margins: PageMargins;
	font: PageFont;
	// Body size in points.
	fontSize: number;
	paragraphStyle: ParagraphStyle;
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
	font: 'georgia',
	fontSize: 12,
	paragraphStyle: 'indent',
	sceneBreak: '* * *',
	pageNumbers: false,
	runningHeader: false
};

export const PAGE_SIZES: Record<PageSize, { label: string; css: string }> = {
	a4: { label: 'A4', css: 'A4' },
	letter: { label: 'US Letter', css: 'letter' },
	'5x8': { label: '5 x 8 in (trade)', css: '5in 8in' },
	'5.5x8.5': { label: '5.5 x 8.5 in (digest)', css: '5.5in 8.5in' },
	'6x9': { label: '6 x 9 in (trade)', css: '6in 9in' }
};

export const PAGE_MARGINS: Record<PageMargins, { label: string; css: string }> = {
	narrow: { label: 'Narrow (1.3 cm)', css: '1.3cm' },
	normal: { label: 'Normal (2 cm)', css: '2cm' },
	wide: { label: 'Wide (2.8 cm)', css: '2.8cm' }
};

export const PAGE_FONTS: Record<PageFont, { label: string; css: string }> = {
	georgia: { label: 'Georgia (serif)', css: "Georgia, 'Times New Roman', serif" },
	times: { label: 'Times (serif)', css: "'Times New Roman', 'Liberation Serif', serif" },
	sans: { label: 'Sans serif', css: "Arial, 'Liberation Sans', sans-serif" }
};

export const FONT_SIZES = [10, 11, 12, 13, 14] as const;
const MAX_SCENE_BREAK = 20;

function isKey<T extends string>(record: Record<T, unknown>, value: unknown): value is T {
	return typeof value === 'string' && value in record;
}

// Defaults applied to whatever is stored; unknown values fall back rather
// than break output when an option is renamed.
export function normalisePageSetup(raw: Record<string, unknown>): PageSetup {
	return {
		pageSize: isKey(PAGE_SIZES, raw.pageSize) ? raw.pageSize : DEFAULT_PAGE_SETUP.pageSize,
		margins: isKey(PAGE_MARGINS, raw.margins) ? raw.margins : DEFAULT_PAGE_SETUP.margins,
		font: isKey(PAGE_FONTS, raw.font) ? raw.font : DEFAULT_PAGE_SETUP.font,
		fontSize: FONT_SIZES.includes(raw.fontSize as (typeof FONT_SIZES)[number])
			? (raw.fontSize as number)
			: DEFAULT_PAGE_SETUP.fontSize,
		paragraphStyle: raw.paragraphStyle === 'spaced' ? 'spaced' : DEFAULT_PAGE_SETUP.paragraphStyle,
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

function cssEscape(text: string): string {
	return text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', ' ');
}

// The parameterized print stylesheet: page geometry, typography, scene
// breaks, and explicit page breaks. The PDF renderer passes the page
// geometry through pdf options instead (Chromium's header/footer layer
// needs it there), so @page is optional.
export function pageCss(setup: PageSetup, options: { includePageRule?: boolean } = {}): string {
	const paragraph =
		setup.paragraphStyle === 'indent'
			? 'margin: 0 0 0.2rem; text-indent: 1.5em;'
			: 'margin: 0 0 0.8em; text-indent: 0;';
	const sceneBreak = setup.sceneBreak
		? `content: '${cssEscape(setup.sceneBreak)}'; color: #444;`
		: "content: '';";
	const pageRule =
		options.includePageRule === false
			? ''
			: `\n@page { size: ${PAGE_SIZES[setup.pageSize].css}; margin: ${PAGE_MARGINS[setup.margins].css}; }`;
	return `body { font-family: ${PAGE_FONTS[setup.font].css}; font-size: ${setup.fontSize}pt; line-height: 1.6; color: #000; margin: 0; }
.title-page { text-align: center; margin: 4rem 0 6rem; page-break-after: always; }
.title-page h1 { font-size: 28pt; font-weight: 600; }
.author { margin-top: 1rem; font-size: 14pt; }
.chapter { page-break-before: always; }
.chapter h2 { text-align: center; font-size: 18pt; margin: 3rem 0 2rem; }
.scene-break { border: 0; text-align: center; margin: 2rem 0; }
.scene-break::after { ${sceneBreak} }
.chapter p { ${paragraph} }
.page-break { page-break-after: always; }
img { max-width: 100%; }${pageRule}`;
}

// Options for Chromium's pdf() call: the page geometry, and when page
// numbers or a running header are on, the header/footer layer that draws
// them.
export function pdfRenderOptions(setup: PageSetup, title: string): Record<string, unknown> {
	const margin = PAGE_MARGINS[setup.margins].css;
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
		margin: { top: margin, bottom: margin, left: margin, right: margin },
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
