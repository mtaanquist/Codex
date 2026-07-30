import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu } from './library';
import { strToU8, zipSync, type Zippable } from 'fflate';

// Builds a minimal but valid .docx in the test so the import covers a real
// Word upload without a binary fixture in the repo.
function buildDocx(paragraphs: string[], title: string): Buffer {
	const body = paragraphs
		.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
		.join('');
	const files: Zippable = {
		'[Content_Types].xml': strToU8(`<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`),
		'_rels/.rels': strToU8(`<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`),
		'docProps/core.xml': strToU8(`<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${title}</dc:title>
</cp:coreProperties>`),
		'word/document.xml': strToU8(`<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`)
	};
	return Buffer.from(zipSync(files));
}

test('story import: preview and import a Word manuscript', async ({ page }) => {
	await gotoReady(page, '/');

	const stamp = Date.now();
	const universeName = `Docland ${stamp}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);

	const title = `Manuscript ${stamp}`;
	const docx = buildDocx(
		[
			'Chapter One',
			'The gate opened.',
			'* * *',
			'Stars above the road.',
			'Chapter Two',
			'They paid in silver.'
		],
		title
	);

	await gotoReady(page, `/universes/docland-${stamp}`);
	await page.getByRole('link', { name: 'Import and export' }).click();
	await page.locator('input[name="archive"]').setInputFiles({
		name: 'manuscript.docx',
		mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		buffer: docx
	});
	await page.getByRole('button', { name: 'Preview' }).click();

	const report = page.locator('.import-report');
	await expect(report).toContainText(`"${title}": 2 chapters, 3 scenes`);

	await page.getByRole('button', { name: 'Import story' }).click();
	await expect(report).toContainText('Imported 3 scenes');
	await page.getByRole('link', { name: 'Open the story' }).click();

	await expect(page.locator('.story-title')).toHaveText(title);
	await expect(page.locator('.chapter-name')).toHaveText(['Chapter 1', 'Chapter 2']);
	await expect(page.locator('.scene-row')).toHaveCount(3);
});
