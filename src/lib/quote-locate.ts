// Locates a quoted passage in a scene body for the Assistant's write tools
// (suggest_edit's original, leave_comment's anchor). An exact match wins; when
// there is none, the search retries against a normalised copy of both texts,
// because small local models routinely echo a passage back with curly quotes
// turned straight (or the reverse) and whitespace runs reflowed. The match is
// mapped back to offsets in the original body, so what gets staged still
// indexes the author's real text.

export type QuoteLocation =
	{ ok: true; start: number; end: number } | { ok: false; reason: 'missing' | 'ambiguous' };

// Typographic quotes and apostrophes folded to their ASCII shape. Primes are
// included because some models substitute them for apostrophes.
const QUOTE_FOLDS: Record<string, string> = {
	'\u2018': "'",
	'\u2019': "'",
	'\u201a': "'",
	'\u201b': "'",
	'\u2032': "'",
	'\u201c': '"',
	'\u201d': '"',
	'\u201e': '"',
	'\u201f': '"',
	'\u2033': '"'
};

// The normalised text alongside, for each of its characters, the index in the
// source text it came from. Every fold is one character for one character and
// a whitespace run becomes a single space, so the map stays exact.
function normalise(text: string): { text: string; map: number[] } {
	let out = '';
	const map: number[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (/\s/.test(ch)) {
			out += ' ';
			map.push(i);
			while (i < text.length && /\s/.test(text[i])) i++;
			continue;
		}
		out += QUOTE_FOLDS[ch] ?? ch;
		map.push(i);
		i++;
	}
	return { text: out, map };
}

export function locateQuote(body: string, quote: string): QuoteLocation {
	if (!quote) return { ok: false, reason: 'missing' };
	const exact = body.indexOf(quote);
	if (exact !== -1) {
		if (body.indexOf(quote, exact + 1) !== -1) return { ok: false, reason: 'ambiguous' };
		return { ok: true, start: exact, end: exact + quote.length };
	}
	const haystack = normalise(body);
	// Trimmed so the match never ends on a collapsed whitespace run, which
	// would leave the end offset ambiguous in the source text.
	const needle = normalise(quote).text.trim();
	if (!needle) return { ok: false, reason: 'missing' };
	const at = haystack.text.indexOf(needle);
	if (at === -1) return { ok: false, reason: 'missing' };
	if (haystack.text.indexOf(needle, at + 1) !== -1) return { ok: false, reason: 'ambiguous' };
	return { ok: true, start: haystack.map[at], end: haystack.map[at + needle.length - 1] + 1 };
}
