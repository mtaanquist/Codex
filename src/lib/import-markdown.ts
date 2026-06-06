import { unzipSync, strFromU8 } from 'fflate';
import { isSceneStatus, type SceneStatus } from './scene-status';

// Parses our own story export zip back into a plan the importer can write:
// story metadata, chapters and scenes in NN- prefix order, story notes, and
// bundled assets. Pure over the zip bytes; tolerant of the gaps older zips
// have (no chapter.md, say) but strict about being a story export at all.

export type ImportedScene = { title: string | null; status: SceneStatus | null; bodyMd: string };
export type ImportedChapter = { title: string | null; scenes: ImportedScene[] };
export type ImportedNote = {
	kind: 'character' | 'place' | 'lore';
	name: string;
	notesMd: string;
};
export type ImportedAsset = { id: string; path: string; bytes: Uint8Array };
export type ImportPlan = {
	story: { title: string; author: string | null; brief: string | null; descriptionMd: string };
	chapters: ImportedChapter[];
	unfiled: ImportedScene[];
	notes: ImportedNote[];
	assets: ImportedAsset[];
	// Tolerated oddities worth telling the author about before they commit.
	problems: string[];
};

export class StoryZipError extends Error {}

type FrontMatter = Record<string, string | string[]>;

// The exporter writes a constrained front matter subset: JSON-quoted scalar
// lines and two-space-indented JSON-quoted list items. Parse exactly that,
// falling back to the raw text for a value that does not parse as JSON.
export function parseFrontMatter(text: string): { fields: FrontMatter; body: string } {
	const lines = text.split('\n');
	if (lines[0] !== '---') return { fields: {}, body: text };
	const close = lines.indexOf('---', 1);
	if (close === -1) return { fields: {}, body: text };

	const fields: FrontMatter = {};
	let listKey: string | null = null;
	for (const line of lines.slice(1, close)) {
		const item = line.match(/^ {2}- (.*)$/);
		if (item && listKey) {
			(fields[listKey] as string[]).push(parseScalar(item[1]));
			continue;
		}
		const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
		if (!pair) continue;
		const value = pair[2].trim();
		if (value === '') {
			listKey = pair[1];
			fields[listKey] = [];
		} else {
			listKey = null;
			fields[pair[1]] = parseScalar(value);
		}
	}
	return { fields, body: lines.slice(close + 1).join('\n') };
}

function parseScalar(value: string): string {
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === 'string' ? parsed : value;
	} catch {
		return value;
	}
}

function scalar(fields: FrontMatter, key: string): string | null {
	const value = fields[key];
	return typeof value === 'string' && value !== '' ? value : null;
}

// "01-the-toll-road" -> "The toll road"; the readable fallback when a title
// only survives as a slug (chapter folders from zips older than chapter.md).
function deslug(name: string): string | null {
	const words = name.replace(/^\d+-/, '').split('-').filter(Boolean).join(' ');
	if (!words) return null;
	return words[0].toUpperCase() + words.slice(1);
}

// The NN- prefix that orders chapter folders and scene files.
function orderOf(name: string): number {
	const match = name.match(/^(\d+)-/);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

const ASSET_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9]+$/;
// A bundled asset link as the exporter writes it: ../ steps up to a relative
// assets/ folder, the original asset id as the file name.
const BUNDLED_ASSET_LINK =
	/(?:\.\.\/)*assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9]+/g;

// Rewrites bundled asset links through the importer's old-id -> new-path map;
// a null mapping leaves the link untouched.
export function rewriteBundledAssetLinks(
	body: string,
	pathFor: (assetId: string) => string | null
): string {
	return body.replace(BUNDLED_ASSET_LINK, (link, assetId: string) => pathFor(assetId) ?? link);
}

export function parseStoryZip(bytes: Uint8Array): ImportPlan {
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(bytes);
	} catch {
		throw new StoryZipError('This file is not a zip archive.');
	}

	// The export wraps everything in one folder named after the story; find
	// story.md (shallowest wins) and treat its folder as the root.
	const storyPath = Object.keys(entries)
		.filter((path) => path === 'story.md' || path.endsWith('/story.md'))
		.sort((a, b) => a.split('/').length - b.split('/').length)[0];
	if (!storyPath) {
		throw new StoryZipError('No story.md found; this is not a Codex story export.');
	}
	const root = storyPath.slice(0, storyPath.length - 'story.md'.length);
	const inRoot = (path: string) => (path.startsWith(root) ? path.slice(root.length) : null);

	const problems: string[] = [];
	const read = (path: string) => strFromU8(entries[path]);

	const storyDoc = parseFrontMatter(read(storyPath));
	const story = {
		title: scalar(storyDoc.fields, 'title') ?? deslug(root.replace(/\/$/, '')) ?? 'Imported story',
		author: scalar(storyDoc.fields, 'author'),
		brief: scalar(storyDoc.fields, 'brief'),
		descriptionMd: storyDoc.body.trim()
	};
	if (!scalar(storyDoc.fields, 'title')) {
		problems.push(`story.md has no title; the story will be named "${story.title}".`);
	}

	const parseScene = (path: string, rel: string): ImportedScene => {
		const doc = parseFrontMatter(read(path));
		const rawStatus = scalar(doc.fields, 'status');
		let status: SceneStatus | null = null;
		if (rawStatus !== null) {
			if (isSceneStatus(rawStatus)) {
				status = rawStatus;
			} else {
				problems.push(`${rel}: unknown status "${rawStatus}"; the scene starts as a draft.`);
			}
		}
		return { title: scalar(doc.fields, 'title'), status, bodyMd: doc.body.trim() };
	};

	// Group chapter files by folder, ordered by the NN- prefix.
	const chapterFiles = new Map<string, { name: string; files: { path: string; file: string }[] }>();
	const unfiled: { path: string; file: string }[] = [];
	const notes: ImportedNote[] = [];
	const assets: ImportedAsset[] = [];

	for (const path of Object.keys(entries)) {
		const rel = inRoot(path);
		if (!rel || rel.endsWith('/')) continue;
		const parts = rel.split('/');
		if (parts[0] === 'chapters' && parts.length === 3 && parts[2].endsWith('.md')) {
			const group = chapterFiles.get(parts[1]) ?? { name: parts[1], files: [] };
			group.files.push({ path, file: parts[2] });
			chapterFiles.set(parts[1], group);
		} else if (parts[0] === 'unfiled' && parts.length === 2 && parts[1].endsWith('.md')) {
			unfiled.push({ path, file: parts[1] });
		} else if (
			parts[0] === 'notes' &&
			parts.length === 3 &&
			['characters', 'places', 'lore'].includes(parts[1]) &&
			parts[2].endsWith('.md')
		) {
			const doc = parseFrontMatter(read(path));
			const kind =
				parts[1] === 'characters' ? 'character' : parts[1] === 'places' ? 'place' : 'lore';
			const name = scalar(doc.fields, 'name');
			if (!name) {
				problems.push(`${rel}: the note names no entity and will be skipped.`);
				continue;
			}
			notes.push({ kind, name, notesMd: doc.body.trim() });
		} else if (parts[0] === 'assets' && parts.length === 2) {
			const match = parts[1].match(ASSET_FILE);
			if (match) assets.push({ id: match[1], path: parts[1], bytes: entries[path] });
		}
	}

	const chapters = [...chapterFiles.values()]
		.sort((a, b) => orderOf(a.name) - orderOf(b.name) || a.name.localeCompare(b.name))
		.map((group) => {
			const meta = group.files.find((f) => f.file === 'chapter.md');
			const title = meta
				? scalar(parseFrontMatter(read(meta.path)).fields, 'title')
				: deslug(group.name);
			const scenes = group.files
				.filter((f) => f.file !== 'chapter.md')
				.sort((a, b) => orderOf(a.file) - orderOf(b.file) || a.file.localeCompare(b.file))
				.map((f) => parseScene(f.path, `chapters/${group.name}/${f.file}`));
			return { title, scenes };
		});

	const unfiledScenes = unfiled
		.sort((a, b) => orderOf(a.file) - orderOf(b.file) || a.file.localeCompare(b.file))
		.map((f) => parseScene(f.path, `unfiled/${f.file}`));

	return { story, chapters, unfiled: unfiledScenes, notes, assets, problems };
}
