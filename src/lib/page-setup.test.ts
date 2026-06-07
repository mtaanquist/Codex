import { describe, it, expect } from 'vitest';
import {
	DEFAULT_PAGE_SETUP,
	mergePageSetup,
	normalisePageSetup,
	pageCss,
	pdfRenderOptions
} from './page-setup';

describe('normalisePageSetup', () => {
	it('returns the defaults for an empty record', () => {
		expect(normalisePageSetup({})).toEqual(DEFAULT_PAGE_SETUP);
	});

	it('keeps valid values and drops junk', () => {
		const setup = normalisePageSetup({
			pageSize: '6x9',
			margins: 'wide',
			font: 'times',
			fontSize: 11,
			paragraphStyle: 'spaced',
			sceneBreak: ' ~ ~ ~ ',
			pageNumbers: true,
			runningHeader: 'yes'
		});
		expect(setup).toEqual({
			pageSize: '6x9',
			margins: 'wide',
			font: 'times',
			fontSize: 11,
			paragraphStyle: 'spaced',
			sceneBreak: '~ ~ ~',
			pageNumbers: true,
			// Only the boolean true counts.
			runningHeader: false
		});
	});

	it('falls back when stored values are unrecognised', () => {
		const setup = normalisePageSetup({ pageSize: 'a0', font: 'comic-sans', fontSize: 7 });
		expect(setup.pageSize).toBe('a4');
		expect(setup.font).toBe('georgia');
		expect(setup.fontSize).toBe(12);
	});

	it('caps a runaway scene break and allows blank', () => {
		expect(normalisePageSetup({ sceneBreak: 'x'.repeat(60) }).sceneBreak).toHaveLength(20);
		expect(normalisePageSetup({ sceneBreak: '' }).sceneBreak).toBe('');
	});
});

describe('mergePageSetup', () => {
	it('story overrides win, the rest falls through', () => {
		const merged = mergePageSetup({ font: 'times', fontSize: 13 }, { fontSize: 11 });
		expect(merged.font).toBe('times');
		expect(merged.fontSize).toBe(11);
		expect(merged.pageSize).toBe('a4');
	});
});

describe('pageCss', () => {
	it("renders the defaults as today's stylesheet", () => {
		const css = pageCss(DEFAULT_PAGE_SETUP);
		expect(css).toContain("font-family: Georgia, 'Times New Roman', serif");
		expect(css).toContain('font-size: 12pt');
		expect(css).toContain("content: '* * *'");
		expect(css).toContain('text-indent: 1.5em');
		expect(css).toContain('@page { size: A4; margin: 2cm; }');
	});

	it('spaced paragraphs drop the indent', () => {
		const css = pageCss({ ...DEFAULT_PAGE_SETUP, paragraphStyle: 'spaced' });
		expect(css).toContain('text-indent: 0');
		expect(css).not.toContain('text-indent: 1.5em');
	});

	it('escapes the scene break text and supports blank', () => {
		expect(pageCss({ ...DEFAULT_PAGE_SETUP, sceneBreak: "don't" })).toContain("don\\'t");
		expect(pageCss({ ...DEFAULT_PAGE_SETUP, sceneBreak: '' })).toContain("content: '';");
		// A scene break carrying markup cannot break out of the <style> element.
		const css = pageCss({ ...DEFAULT_PAGE_SETUP, sceneBreak: '</style>x' });
		expect(css).not.toContain('</style>');
		expect(css).toContain('\\3c /style>x');
	});

	it('omits the page rule for the PDF renderer', () => {
		expect(pageCss(DEFAULT_PAGE_SETUP, { includePageRule: false })).not.toContain('@page');
	});

	it('always styles explicit page breaks', () => {
		expect(pageCss(DEFAULT_PAGE_SETUP)).toContain('.page-break { page-break-after: always; }');
	});
});

describe('pdfRenderOptions', () => {
	it('uses named formats for office sizes and dimensions for trims', () => {
		expect(pdfRenderOptions(DEFAULT_PAGE_SETUP, 'T')).toMatchObject({ format: 'a4' });
		expect(pdfRenderOptions({ ...DEFAULT_PAGE_SETUP, pageSize: '5x8' }, 'T')).toMatchObject({
			width: '5in',
			height: '8in'
		});
	});

	it('passes the margins through', () => {
		expect(pdfRenderOptions({ ...DEFAULT_PAGE_SETUP, margins: 'narrow' }, 'T')).toMatchObject({
			margin: { top: '1.3cm', bottom: '1.3cm', left: '1.3cm', right: '1.3cm' }
		});
	});

	it('only draws the header and footer layer when asked', () => {
		expect(pdfRenderOptions(DEFAULT_PAGE_SETUP, 'T')).not.toHaveProperty('displayHeaderFooter');
		const numbered = pdfRenderOptions({ ...DEFAULT_PAGE_SETUP, pageNumbers: true }, 'T');
		expect(numbered).toMatchObject({ displayHeaderFooter: true });
		expect(String(numbered.footerTemplate)).toContain('pageNumber');
		expect(String(numbered.headerTemplate)).not.toContain('pageNumber');
	});

	it('escapes the running header title', () => {
		const options = pdfRenderOptions(
			{ ...DEFAULT_PAGE_SETUP, runningHeader: true },
			'Ash & <Bone>'
		);
		expect(String(options.headerTemplate)).toContain('Ash &amp; &lt;Bone&gt;');
	});
});
