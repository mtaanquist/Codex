import type { ImportedChapter, ImportedScene } from './import-markdown';

// Turns a flat run of document blocks (headings and paragraphs, as a Word or
// EPUB manuscript yields) into chapters and scenes, guessing structure from the
// conventions manuscripts actually use: repeated heading levels, "Chapter N"
// lines, and scene-break glyphs. When it finds nothing to split on, everything
// lands in one chapter and one scene. Pure over its input, no I/O.

export type DocBlock =
	| { kind: 'heading'; level: number; text: string }
	| { kind: 'para'; md: string };

export type DetectedStructure = { chapters: ImportedChapter[]; problems: string[] };

const NUMBER_WORD =
	'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred';
// "Chapter 1", "Part Two", "Book IV" -- the keyword must be followed by a
// number, so prose like "Chapter house was quiet" is not mistaken for a heading.
const CHAPTER_LABEL = new RegExp(
	`^(chapter|part|book)\\s+(\\d+|[ivxlcdm]+|(?:${NUMBER_WORD})(?:[\\s-](?:${NUMBER_WORD}))*)\\b`,
	'i'
);
const STANDALONE_LABEL = /^(prologue|epilogue|interlude)\b/i;
// A label with nothing descriptive past the number ("Chapter 1", "Part Two")
// reads better as the app's own "Chapter N" default than as a literal title.
const GENERIC_LABEL = /^(chapter|part|book)\b[\s:.-]*(\d+|[ivxlcdm]+|[a-z]+)?$/i;
const NUMBER_ONLY = /^\d{1,3}$/;
// Roman numerals only when upper-case: lower-case "did", "mill", "civic" are
// real words made of roman letters and would trip a loose match.
const ROMAN_ONLY = /^[IVXLCDM]+$/;

function isChapterMarker(text: string): boolean {
	const s = text.trim();
	if (s.length === 0 || s.length > 60) return false;
	return (
		CHAPTER_LABEL.test(s) || STANDALONE_LABEL.test(s) || NUMBER_ONLY.test(s) || ROMAN_ONLY.test(s)
	);
}

// The visible chapter title, or null to let the schema show "Chapter N".
function chapterTitle(text: string): string | null {
	const s = text.trim();
	if (GENERIC_LABEL.test(s) || NUMBER_ONLY.test(s) || ROMAN_ONLY.test(s)) return null;
	return s;
}

function isSceneBreak(text: string): boolean {
	const compact = text.trim().replace(/\s+/g, '');
	if (compact === '') return false;
	return (
		/^\*{3,}$/.test(compact) || // *** and * * *
		/^-{3,}$/.test(compact) || // ---
		/^_{3,}$/.test(compact) || // ___
		/^#{1,6}$/.test(compact) || // a bare hash divider
		/^[•·◆❖✦＊∗⁂~]{1,7}$/u.test(compact) // dinkus glyphs
	);
}

function headingText(text: string): string | null {
	const s = text.trim();
	return s === '' ? null : s;
}

function blockToMarkdown(block: DocBlock): string {
	if (block.kind === 'para') return block.md.trim();
	const level = Math.min(6, Math.max(1, block.level));
	return `${'#'.repeat(level)} ${block.text.trim()}`;
}

// The shallowest heading level that repeats marks chapters: a single lone top
// heading is a book title, not a chapter. Returns null when no heading level
// looks like a chapter run.
function chapterHeadingLevel(blocks: DocBlock[]): number | null {
	const counts = new Map<number, number>();
	for (const block of blocks) {
		if (block.kind === 'heading') counts.set(block.level, (counts.get(block.level) ?? 0) + 1);
	}
	if (counts.size === 0) return null;
	const levels = [...counts.keys()].sort((a, b) => a - b);
	for (const level of levels) {
		if ((counts.get(level) ?? 0) >= 2) return level;
	}
	const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
	return total >= 2 ? levels[0] : null;
}

type Boundary =
	| { type: 'chapter'; title: string | null }
	| { type: 'scene'; title: string | null }
	| { type: 'skip' };

function classify(block: DocBlock, chapterLevel: number | null): Boundary | null {
	if (block.kind === 'heading') {
		if (chapterLevel === null) return { type: 'scene', title: headingText(block.text) };
		if (block.level === chapterLevel) return { type: 'chapter', title: chapterTitle(block.text) };
		if (block.level > chapterLevel) return { type: 'scene', title: headingText(block.text) };
		// A heading shallower than the chapter level is a book or part title
		// above Codex's flat chapter model; drop it rather than manufacture a
		// stray chapter from it. The story title comes from document metadata.
		return { type: 'skip' };
	}
	if (isSceneBreak(block.md)) return { type: 'scene', title: null };
	// Paragraph chapter markers only count when headings did not define chapters,
	// so a heading-structured document is not re-split by a stray "Chapter" line.
	if (chapterLevel === null && isChapterMarker(block.md)) {
		return { type: 'chapter', title: chapterTitle(block.md) };
	}
	return null;
}

export function detectStructure(blocks: DocBlock[]): DetectedStructure {
	const problems: string[] = [];
	const chapterLevel = chapterHeadingLevel(blocks);

	const chapters: ImportedChapter[] = [];
	let chapter: ImportedChapter | null = null;
	let sceneTitle: string | null = null;
	let sceneParts: string[] = [];
	let sawChapterBreak = false;
	let sawSceneBreak = false;

	const flushScene = () => {
		if (!chapter) return;
		const bodyMd = sceneParts.join('\n\n').trim();
		if (bodyMd !== '' || sceneTitle !== null) {
			chapter.scenes.push({ title: sceneTitle, status: null, bodyMd });
		}
		sceneTitle = null;
		sceneParts = [];
	};

	const startChapter = (title: string | null) => {
		flushScene();
		chapter = { title, scenes: [] };
		chapters.push(chapter);
	};

	for (const block of blocks) {
		const boundary = classify(block, chapterLevel);
		if (boundary?.type === 'skip') continue;
		if (boundary?.type === 'chapter') {
			sawChapterBreak = true;
			startChapter(boundary.title);
			continue;
		}
		if (!chapter) startChapter(null); // an implicit first chapter for leading prose
		if (boundary?.type === 'scene') {
			sawSceneBreak = true;
			flushScene();
			sceneTitle = boundary.title;
			continue;
		}
		const md = blockToMarkdown(block);
		if (md !== '') sceneParts.push(md);
	}
	flushScene();

	// Drop an implicit, untitled chapter that never gathered any prose (a
	// document that opens straight on its first chapter heading).
	const kept = chapters.filter((c) => c.scenes.length > 0 || c.title !== null);

	if (kept.length === 0) {
		problems.push('No readable text was found; the story was created with one empty scene.');
		return {
			chapters: [{ title: null, scenes: [{ title: null, status: null, bodyMd: '' }] }],
			problems
		};
	}

	if (!sawChapterBreak && !sawSceneBreak) {
		problems.push(
			'No chapter or scene breaks were found, so the whole document was imported as a single scene.'
		);
	}

	return { chapters: kept, problems };
}

// Splits a markdown string into blocks: ATX heading lines become heading
// blocks, blank-line separated runs become paragraph blocks (lists and
// blockquotes ride along unchanged as paragraph content). The shared bridge
// from any HTML-to-markdown conversion into detectStructure.
export function markdownToBlocks(markdown: string): DocBlock[] {
	const blocks: DocBlock[] = [];
	const chunks = markdown.replace(/\r\n?/g, '\n').split(/\n{2,}/);
	for (const chunk of chunks) {
		const trimmed = chunk.trim();
		if (trimmed === '') continue;
		const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
		if (heading && !trimmed.includes('\n')) {
			blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
		} else {
			blocks.push({ kind: 'para', md: trimmed });
		}
	}
	return blocks;
}

export type { ImportedChapter, ImportedScene };
