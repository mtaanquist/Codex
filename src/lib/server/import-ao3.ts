// Reads the structure of an EPUB downloaded from Archive of Our Own. AO3
// generates every download from the same template (Calibre then splits it into
// files and renames most classes), so the work is found by element ids, tag
// shapes, and the fixed labels AO3 prints: a preface with the tag list, summary
// and notes; a chapters block of heading, prose and end-notes groups; and an
// afterword. Returns HTML fragments; the caller converts them to markdown.
// Expects the well-formed XHTML an EPUB carries. Pure, no I/O.

export type Ao3Chapter = {
	title: string | null;
	summaryHtml: string | null;
	notesHtml: string | null;
	endNotesHtml: string | null;
	proseHtml: string;
};

export type Ao3Work = {
	sourceUrl: string | null;
	// Tag groups in the order AO3 lists them, e.g. ["Rating", ["Explicit"]].
	tags: [string, string[]][];
	summaryHtml: string | null;
	notesHtml: string | null;
	endNotesHtml: string | null;
	chapters: Ao3Chapter[];
};

type El = { tag: string; attrs: string; inner: string; outer: string };

const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'wbr', 'area']);

// The top-level elements of an XHTML fragment, in order. Text between them is
// ignored; comments, CDATA, and processing instructions are skipped.
function childElements(html: string): El[] {
	const out: El[] = [];
	// Attribute text never contains "<" in well-formed XHTML; excluding it keeps
	// a stray unterminated tag from making every match scan to the end.
	const re =
		/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"<]*"|'[^'<]*')*?)(\/?)>/g;
	let depth = 0;
	let open: { tag: string; attrs: string; start: number; innerStart: number } | null = null;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		if (!m[2]) continue;
		const closing = m[1] === '/';
		const tag = m[2].toLowerCase();
		const selfClosing = m[4] === '/' || VOID_TAGS.has(tag);
		if (closing) {
			// "<br></br>" is legal XHTML; the opening tag already counted as complete.
			if (VOID_TAGS.has(tag)) continue;
			depth -= 1;
			if (depth === 0 && open) {
				out.push({
					tag: open.tag,
					attrs: open.attrs,
					inner: html.slice(open.innerStart, m.index),
					outer: html.slice(open.start, m.index + m[0].length)
				});
				open = null;
			}
			if (depth < 0) depth = 0;
		} else if (selfClosing) {
			if (depth === 0) out.push({ tag, attrs: m[3], inner: '', outer: m[0] });
		} else {
			if (depth === 0) {
				open = { tag, attrs: m[3], start: m.index, innerStart: m.index + m[0].length };
			}
			depth += 1;
		}
	}
	return out;
}

function attrOf(el: El, name: string): string | null {
	const match = el.attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
	return match ? (match[1] ?? match[2]) : null;
}

function decode(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

function textOf(html: string): string {
	return decode(html.replace(/<[^>]*>/g, ''))
		.replace(/\s+/g, ' ')
		.trim();
}

// The first non-div element, descending through wrapper divs.
function firstLeaf(el: El): El | undefined {
	if (el.tag !== 'div') return el;
	const first = childElements(el.inner)[0];
	return first ? firstLeaf(first) : undefined;
}

// Descends through wrapper divs so label paragraphs and blockquotes sit in one
// flat run whatever nesting Calibre's split left them in.
function flatten(html: string): El[] {
	return childElements(html).flatMap((el) => (el.tag === 'div' ? flatten(el.inner) : [el]));
}

// The blockquote following each fixed label ("Summary", "Chapter Notes", ...).
function labelled(html: string): Map<string, string> {
	const found = new Map<string, string>();
	const run = flatten(html);
	for (let i = 0; i < run.length - 1; i++) {
		if (run[i].tag !== 'p' || run[i + 1].tag !== 'blockquote') continue;
		const label = textOf(run[i].inner);
		if (!found.has(label)) found.set(label, run[i + 1].inner);
	}
	return found;
}

function tagList(html: string): [string, string[]][] {
	const groups: [string, string[]][] = [];
	for (const dl of flatten(html).filter((el) => el.tag === 'dl')) {
		let label: string | null = null;
		for (const el of childElements(dl.inner)) {
			if (el.tag === 'dt') label = textOf(el.inner).replace(/:$/, '');
			else if (el.tag === 'dd' && label) {
				const links = childElements(el.inner).filter((child) => child.tag === 'a');
				const values =
					links.length > 0 && label !== 'Series'
						? links.map((a) => textOf(a.inner))
						: [textOf(el.inner)];
				groups.push([label, values.filter((v) => v !== '')]);
				label = null;
			}
		}
	}
	return groups;
}

// "Chapter 3: The Glasses" -> "The Glasses"; a bare "Chapter 3" -> null so the
// app shows its own "Chapter N".
function chapterTitle(heading: string): string | null {
	const rest = heading.replace(/^chapter\s+\d+\s*(?::\s*)?/i, '').trim();
	return rest === '' ? null : rest;
}

function hasContent(html: string): boolean {
	return textOf(html) !== '' || /<img\b/i.test(html);
}

// Null when the bodies do not follow AO3's download template.
export function parseAo3Bodies(bodies: string[]): Ao3Work | null {
	const sections = bodies.flatMap(childElements);
	const byId = (id: string) => sections.filter((el) => attrOf(el, 'id') === id);
	const chapterBlocks = byId('chapters');
	if (chapterBlocks.length === 0) return null;

	const work: Ao3Work = {
		sourceUrl: null,
		tags: [],
		summaryHtml: null,
		notesHtml: null,
		endNotesHtml: null,
		chapters: []
	};

	for (const preface of byId('preface')) {
		const link = preface.inner.match(/href="(https?:\/\/[^"]*\/works\/\d+)"/);
		if (link && !work.sourceUrl) work.sourceUrl = decode(link[1]);
		work.tags.push(...tagList(preface.inner));
		const labels = labelled(preface.inner);
		work.summaryHtml ??= labels.get('Summary') ?? null;
		work.notesHtml ??= labels.get('Notes') ?? null;
	}
	for (const afterword of byId('afterword')) {
		work.endNotesHtml ??= labelled(afterword.inner).get('End Notes') ?? null;
	}

	let chapter: Ao3Chapter | null = null;
	const startChapter = (title: string | null) => {
		chapter = { title, summaryHtml: null, notesHtml: null, endNotesHtml: null, proseHtml: '' };
		work.chapters.push(chapter);
		return chapter;
	};
	for (const block of chapterBlocks) {
		for (const el of childElements(block.inner)) {
			const first = firstLeaf(el);
			// AO3 classes its chapter headings "heading"; the text check covers a
			// Calibre run that renamed the class.
			const isHeading =
				el.tag === 'div' &&
				first?.tag === 'h2' &&
				(/\bheading\b/.test(attrOf(first, 'class') ?? '') ||
					/^chapter \d+\b/i.test(textOf(first.inner))) &&
				!(attrOf(el, 'id') ?? '').startsWith('endnotes');
			if (isHeading) {
				const labels = labelled(el.inner);
				const current = startChapter(chapterTitle(textOf(first.inner)));
				current.summaryHtml = labels.get('Chapter Summary') ?? null;
				current.notesHtml = labels.get('Chapter Notes') ?? null;
			} else if ((attrOf(el, 'id') ?? '').startsWith('endnotes')) {
				const target: Ao3Chapter = chapter ?? startChapter(null);
				target.endNotesHtml = labelled(el.inner).get('Chapter End Notes') ?? null;
			} else if (hasContent(el.outer)) {
				// A one-chapter work has no heading; its prose opens the only chapter.
				const target: Ao3Chapter = chapter ?? startChapter(null);
				target.proseHtml += el.tag === 'div' ? el.inner : el.outer;
			}
		}
	}
	return work;
}
