import { describe, it, expect } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';
import {
	parseFrontMatter,
	parseStoryZip,
	rewriteBundledAssetLinks,
	StoryZipError
} from './import-markdown';

const ASSET_ID = '0b154c2d-13ef-4f3c-9a85-2f1c0a9d8e11';

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
	const entries: Zippable = {};
	for (const [path, content] of Object.entries(files)) {
		entries[path] = typeof content === 'string' ? strToU8(content) : content;
	}
	return zipSync(entries);
}

describe('parseFrontMatter', () => {
	it('reads JSON-quoted scalars and lists, leaving the body intact', () => {
		const { fields, body } = parseFrontMatter(
			'---\ntitle: "A \\"quoted\\" name"\naliases:\n  - "One"\n  - "Two"\n---\nThe body.\n\n---\nNot front matter.'
		);
		expect(fields.title).toBe('A "quoted" name');
		expect(fields.aliases).toEqual(['One', 'Two']);
		expect(body).toBe('The body.\n\n---\nNot front matter.');
	});

	it('treats text without a front matter block as all body', () => {
		expect(parseFrontMatter('Just prose.').body).toBe('Just prose.');
		expect(parseFrontMatter('---\nnever closed').body).toBe('---\nnever closed');
	});

	it('falls back to the raw text for unquoted values', () => {
		expect(parseFrontMatter('---\ntitle: Plain words\n---\n').fields.title).toBe('Plain words');
	});
});

describe('parseStoryZip', () => {
	const full = () =>
		zip({
			'halden/story.md': '---\ntitle: "Halden"\nauthor: "A. Vane"\n---\nThe description.',
			'halden/chapters/02-the-road/chapter.md': '---\ntitle: "The Road"\n---\n',
			'halden/chapters/02-the-road/01-tollgate.md':
				'---\ntitle: "Tollgate"\nstatus: "final"\n---\nThey paid.',
			'halden/chapters/01-the-caravan/chapter.md': '---\ntitle: "The Caravan"\n---\n',
			'halden/chapters/01-the-caravan/01-departure.md':
				'---\ntitle: "Departure"\nstatus: "draft"\n---\nThe gate opened.',
			'halden/chapters/01-the-caravan/02-night.md':
				'---\ntitle: "Night"\nstatus: "sketchy"\n---\nStars.',
			'halden/unfiled/01-loose-end.md': '---\ntitle: "Loose end"\n---\nA thought.',
			'halden/notes/characters/alice-vane.md':
				'---\nname: "Alice Vane"\nkind: "character"\n---\nLimps here.',
			'halden/notes/lore/the-toll.md': '---\nname: "The Toll"\nkind: "lore"\n---\nSteep.',
			[`halden/assets/${ASSET_ID}.png`]: new Uint8Array([1, 2, 3])
		});

	it('rebuilds the story plan in NN order with notes and assets', () => {
		const plan = parseStoryZip(full());
		expect(plan.story).toEqual({
			title: 'Halden',
			author: 'A. Vane',
			brief: null,
			descriptionMd: 'The description.'
		});
		expect(plan.chapters.map((c) => c.title)).toEqual(['The Caravan', 'The Road']);
		expect(plan.chapters[0].scenes.map((s) => s.title)).toEqual(['Departure', 'Night']);
		expect(plan.chapters[0].scenes[0]).toEqual({
			title: 'Departure',
			status: 'draft',
			bodyMd: 'The gate opened.'
		});
		expect(plan.unfiled).toEqual([{ title: 'Loose end', status: null, bodyMd: 'A thought.' }]);
		expect(plan.notes).toEqual([
			{ kind: 'character', name: 'Alice Vane', notesMd: 'Limps here.' },
			{ kind: 'lore', name: 'The Toll', notesMd: 'Steep.' }
		]);
		expect(plan.assets).toEqual([
			{ id: ASSET_ID, path: `${ASSET_ID}.png`, bytes: new Uint8Array([1, 2, 3]) }
		]);
	});

	it('flags unknown statuses as problems and starts those scenes as drafts', () => {
		const plan = parseStoryZip(full());
		expect(plan.chapters[0].scenes[1].status).toBeNull();
		expect(plan.problems).toEqual([expect.stringContaining('unknown status "sketchy"')]);
	});

	it('falls back to de-slugified chapter names for zips without chapter.md', () => {
		const plan = parseStoryZip(
			zip({
				'story.md': '---\ntitle: "Old Export"\n---\n',
				'chapters/01-the-long-road/01-scene.md': '---\ntitle: "S"\n---\nText.'
			})
		);
		expect(plan.chapters[0].title).toBe('The long road');
	});

	it('names an untitled story and skips nameless notes, with problems', () => {
		const plan = parseStoryZip(
			zip({
				'my-tale/story.md': 'Only a description.',
				'my-tale/notes/places/somewhere.md': 'No front matter.'
			})
		);
		expect(plan.story.title).toBe('My tale');
		expect(plan.notes).toEqual([]);
		expect(plan.problems).toHaveLength(2);
	});

	it('rejects archives that are not story exports', () => {
		expect(() => parseStoryZip(strToU8('not a zip'))).toThrow(StoryZipError);
		expect(() => parseStoryZip(zip({ 'readme.md': 'hello' }))).toThrow(StoryZipError);
	});

	it('rejects an archive with too many entries before unpacking', () => {
		const files: Record<string, string> = { 'story.md': 'x' };
		for (let i = 0; i < 5001; i++) files[`unfiled/${i}-s.md`] = 'x';
		expect(() => parseStoryZip(zip(files))).toThrow(/too many files/);
	});

	it('rejects an oversized entry before decompressing it', () => {
		// Compresses to almost nothing, but the central directory reports the
		// full size, so the cap trips without expanding it in memory.
		const big = new Uint8Array(51 * 1024 * 1024);
		expect(() => parseStoryZip(zip({ 'story.md': 'x', 'unfiled/01-s.md': big }))).toThrow(
			/too large/
		);
	});
});

describe('rewriteBundledAssetLinks', () => {
	it('rewrites mapped relative links and leaves the rest alone', () => {
		const body = `![a](../../assets/${ASSET_ID}.png) ![b](assets/${ASSET_ID}.png) ![c](/assets/${ASSET_ID})`;
		const out = rewriteBundledAssetLinks(body, (id) => (id === ASSET_ID ? '/assets/new-id' : null));
		expect(out).toBe(`![a](/assets/new-id) ![b](/assets/new-id) ![c](/assets/${ASSET_ID})`);
	});

	it('leaves links untouched when the map declines', () => {
		const body = `![a](../assets/${ASSET_ID}.png)`;
		expect(rewriteBundledAssetLinks(body, () => null)).toBe(body);
	});
});
