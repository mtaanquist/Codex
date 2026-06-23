import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { strToU8, zipSync, type Zippable } from 'fflate';
import * as schema from '../../src/lib/server/db/schema';
import { chapters, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import { parseDocument } from '../../src/lib/server/import-document';
import { previewImport, runImport } from '../../src/lib/server/import-story';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universe: { id: string; ownerId: string };

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

// A minimal .docx mammoth can read, with optional title and an inline image.
function buildDocx(
	paragraphs: string[],
	opts: { title?: string; withImage?: boolean } = {}
): Uint8Array {
	const body = paragraphs
		.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
		.join('');
	const image = opts.withImage
		? `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImg1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
		: '';
	const files: Zippable = {
		'[Content_Types].xml': strToU8(`<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
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
  <dc:title>${opts.title ?? ''}</dc:title>
</cp:coreProperties>`),
		'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`),
		'word/media/image1.png': new Uint8Array(PNG),
		'word/document.xml': strToU8(`<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>${body}${image}</w:body>
</w:document>`)
	};
	return zipSync(files);
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table scenes, chapters, stories, universes, users cascade');
	const [owner] = await db
		.insert(users)
		.values({ email: 'doc@example.com', displayName: 'D', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [row] = await db.insert(universes).values({ ownerId, name: 'Mythos' }).returning();
	universe = { id: row.id, ownerId };
});

afterAll(async () => {
	await pool.end();
});

describe('document import end to end', () => {
	it('previews chapter and scene counts without writing anything', async () => {
		const plan = await parseDocument(
			buildDocx(
				['Chapter One', 'The gate opened.', '* * *', 'Stars above.', 'Chapter Two', 'They paid.'],
				{
					title: 'Halden'
				}
			),
			'halden.docx'
		);
		const preview = await previewImport(db, universe, plan);
		expect(preview.storyTitle).toBe('Halden');
		expect(preview.chapterCount).toBe(2);
		expect(preview.sceneCount).toBe(3);
		expect(preview.words).toBeGreaterThan(0);
		expect(await db.select().from(stories)).toHaveLength(0);
	});

	it('imports a Word manuscript into chapters and scenes', async () => {
		const plan = await parseDocument(
			buildDocx(
				['Chapter One', 'The gate opened.', '* * *', 'Stars above.', 'Chapter Two', 'They paid.'],
				{
					title: 'Halden'
				}
			),
			'halden.docx'
		);
		const result = await runImport(db, universe, plan);
		expect(result.sceneCount).toBe(3);

		const [story] = await db.select().from(stories).where(eq(stories.id, result.storyId));
		expect(story.title).toBe('Halden');

		const chapterRows = await db
			.select()
			.from(chapters)
			.where(eq(chapters.storyId, result.storyId))
			.orderBy(asc(chapters.position));
		expect(chapterRows).toHaveLength(2);

		const sceneRows = await db
			.select()
			.from(scenes)
			.where(eq(scenes.storyId, result.storyId))
			.orderBy(asc(scenes.globalPosition));
		expect(sceneRows.map((s) => s.bodyMd)).toEqual([
			'The gate opened.',
			'Stars above.',
			'They paid.'
		]);
		// Imported manuscripts start as drafts.
		expect(sceneRows.every((s) => s.status === 'draft')).toBe(true);
		expect(sceneRows[0].chapterId).toBe(chapterRows[0].id);
		expect(sceneRows[0].wordCount).toBeGreaterThan(0);
	});

	it('reports embedded images as skipped when asset storage is not configured', async () => {
		const plan = await parseDocument(buildDocx(['Prose.'], { withImage: true }), 'book.docx');
		expect(plan.assets).toHaveLength(1);
		const result = await runImport(db, universe, plan);
		expect(result.problems.some((p) => p.toLowerCase().includes('image storage'))).toBe(true);
	});
});
