# Custom paragraph styles (#309) - feasibility

Status: design write-up for discussion. No code yet.

## The real ask

The GitHub issue frames this as Word/OpenOffice "custom styles": a style dropdown plus
a per-style editor, per user. Talking to the writer who reported it narrowed it:

- The primary need is **per-paragraph** styling: apply a specific style to **one
  paragraph** (their examples are **line spacing and indents** - e.g. an indented,
  tighter block; a single-spaced verse stanza; an epigraph).
- **Alignment** is already handled the way they want, via the formatting toolbar.
- A **document-level line-spacing** control (whole manuscript) would also be nice, but
  it is secondary.

So this is two separable pieces:

1. **Per-paragraph styles** (the real ask) - styling that targets individual paragraphs.
2. **Document-level line spacing** (bonus) - one knob for the whole manuscript.

They use different machinery, and we already have both kinds in the codebase.

## The hard constraint

Authored content stays as markdown that round-trips through export (a core principle).
Anything per-paragraph must survive as **plain text in the `.md`**, and must render the
same across **six surfaces**: the CodeMirror editor, the in-app preview, the browser
print route, the worker PDF, the EPUB, and the public reading page.

Markdown has no syntax for line spacing or indents, so we cannot lean on CommonMark. We
need a representation that is (a) plain text and (b) understood by every renderer.

## What already exists (two levers)

### Lever A - document-level: page setup

`src/lib/page-setup.ts` holds a per-story / per-user `PageSetup`. It already has a
**paragraph knob**: `paragraphStyle: 'indent' | 'spaced'` (first-line indent vs. blank
line between paragraphs), plus page size, margins, font, font size, scene break, etc.
`pageCss(setup)` turns it into the print/PDF stylesheet; the in-app preview, print route,
and EPUB each re-derive equivalent CSS. **Line height is hardcoded at 1.6** in every one
of those places.

- Scope: stored on `users.pageSetup` (account default) and `stories.pageSetup` (per-story
  override); `storyPageSetup()` merges them.
- Round-trip: trivial. It is export configuration stored beside the prose, never in it.
- Gap: it is applied to preview/print/PDF/EPUB but **not shown in the editor**, and the
  **public reader ignores page setup** (hardcoded indent + 1.7 line-height).

### Lever B - per-paragraph: the marker pattern

Per-paragraph alignment already works end to end via a marker that rides in the markdown:

- `\center`, `\right`, `\justify` at a paragraph's start (`src/lib/alignment.ts`).
- `src/lib/markdown.ts` (`alignments()` core rule) strips the marker and adds an
  `align-<dir>` class to the `<p>`. `\page` works the same way.
- The editor shows it live: `editor-alignment.ts` decorates the paragraph and dims/hides
  the marker (and the new "hide command markers" toggle, #306, already hides it on idle
  lines). `editor-format.ts` `setAlignmentChanges()` is the toolbar command that writes
  the marker.
- It renders in all six surfaces because each surface's stylesheet has an `.align-center`
  rule (the CSS is duplicated per surface - see "cost" below).

This is the proven template for round-trip-safe per-paragraph styling. Per-paragraph
**line spacing and indents** are the same shape of problem as alignment, so they fit this
pattern directly.

## Options for the per-paragraph piece

### Option A - a curated set of paragraph-style markers (recommended start)

Add a small, fixed set of paragraph styles, each a marker that mirrors alignment:
e.g. `\block` (indented block), `\flush` (no first-line indent), `\loose` / `\tight`
(per-paragraph line spacing), `\verse` (preserve line breaks, single-spaced). Applied
from a "paragraph style" menu in the formatting toolbar, exactly like the alignment
buttons.

- Representation: `\<style> ` at paragraph start, parsed by extending the existing
  `markdown.ts` core rule to add a `pstyle-<name>` class alongside any `align-*` class.
- Renders everywhere: add a hardcoded `.pstyle-block { ... }` rule to each surface's
  stylesheet (the same spread alignment already pays).
- Editor: renders live by extending `editor-alignment.ts` (decorate the paragraph, hide
  the marker on idle lines via the #306 toggle). Reuses everything.
- Round-trip: identical to alignment - the marker is plain text; no external definitions
  needed because the styles are a fixed vocabulary every renderer knows.
- Cost: small-to-medium. One marker grammar, one editor extension change, one CSS rule
  per surface per style, one toolbar menu. No schema, no storage.
- Limit: the writer cannot invent their own styles or tune the numbers - they pick from
  the curated set. For "line spacing and indents on a paragraph," a good curated set
  likely covers it.

### Option B - named, user-defined styles (the full issue)

The Word-like vision: the writer defines named styles ("Verse", "Letter", "Epigraph")
with properties (line spacing, first-line indent, left/right indent, space before/after,
font size), applies them from a dropdown, and edits a definition to restyle every
paragraph using it.

- Representation: a marker carrying the style id, e.g. `\style:verse ` at paragraph start;
  the renderer maps it to a `style-verse` class.
- Storage: a `paragraph_styles` table (per user, or per universe/story - open decision),
  each row a name + a property bundle.
- The catch (architecture): the marker alone is not enough - every render surface must be
  handed the **style definitions** to emit their CSS. `renderMarkdown()` is currently a
  pure, shared, definition-free function used by preview, exports, and the public reader.
  Named styles mean threading the user's style set into all six surfaces and generating
  CSS from it (or inlining `style="..."` per paragraph, which bloats output and fights the
  EPUB/print stylesheet model). This is the bulk of the work.
- Round-trip: fine **within Codex** - the marker is plain text and the Codex export ZIP
  can bundle the definitions (as it already bundles notes/assets). A foreign markdown tool
  would see `\style:verse` as literal text and not know "verse" (acceptable and the same
  as `\center` looking odd elsewhere) - worth documenting.
- A per-paragraph **line-spacing override** inside a flowed manuscript is typographically
  unusual; supported fine by CSS on the `<p>`, just noting it is a real capability here.
- Cost: large. Schema + CRUD + a style editor UI + the definition-threading across six
  surfaces + the export-bundle format. This is a Phase-2-sized feature.

### Option C - phase it (recommended)

Ship Option A first (it directly serves the reporter and reuses the alignment machinery),
plus the document-level line-spacing knob below. Revisit Option B only if real demand for
arbitrary, named, tunable styles shows up. The two are compatible: a later named-style
system can subsume the curated markers, or keep them as built-ins.

## The document-level line-spacing knob (the "also nice")

Independent of the above and cheap:

- Add `lineSpacing` (e.g. `'single' | 'relaxed' | 'double'`, or a number) to `PageSetup`
  and `DEFAULT_PAGE_SETUP`.
- Replace the hardcoded `line-height: 1.6` in the four places that build page CSS
  (`pageCss()`, the print route's Svelte `<style>`, the in-app preview's `<style>`,
  `epubStyle()`).
- Add a control to the two page-setup forms (story settings + account default).
- Consider wiring the public reader (currently hardcoded 1.7) to read page setup, or leave
  it independent (open decision).
- Round-trip: free - it is export config, not prose.

The existing `paragraphStyle` (indent/spaced) is the document-level **indent** control
already; only line spacing is missing at this level.

## The real cost, wherever we land: surface spread + CSS duplication

The dominant cost of any per-paragraph styling is that it must be applied in **six
surfaces**, and today each surface keeps its **own copy** of the paragraph CSS (the print
route, the preview, `pageCss()`, `epubStyle()`, and the public reader all repeat the
indent/spaced/align rules, with small drifts already - e.g. 0.8em vs 0.85em margins, 1.6
vs 1.7 line-height). Before piling more paragraph CSS on, it is worth **consolidating the
paragraph stylesheet** so there is one source the surfaces share (extend `pageCss()` and
have the Svelte surfaces consume it). That refactor de-risks every option here and fixes
the existing drift.

The editor is the seventh surface and the one with the biggest gap: it reflects alignment
markers but not paragraph spacing/indent. Option A's markers render there for free via the
alignment-extension mechanism; document-level page-setup styling in the editor is a
separate, optional improvement.

## Recommendation

1. **Consolidate** the per-paragraph/page CSS into one shared builder (small refactor,
   removes drift, prerequisite for the rest).
2. **Phase 1**: a curated **paragraph-style menu** (Option A) - markers rendered across all
   surfaces and the editor, hide-able via the #306 command-marker toggle - **plus** the
   document-level **`lineSpacing`** page-setup knob. This serves the reporter's actual
   use case (per-paragraph spacing/indents) and the bonus, with no schema and bounded risk.
3. **Phase 2 (only if demand)**: named, user-defined styles (Option B), accepting the
   definition-threading and export-bundle work.

## Open decisions for you

1. **The curated set (Phase 1):** which paragraph styles, concretely? Candidates: block
   indent, no-indent/flush, looser line spacing, tighter line spacing, verse
   (preserve-breaks). What does the writer actually reach for?
2. **Named styles later (Phase 2):** if/when we do them, are styles **per-user**,
   **per-universe**, or **per-story**? (The issue said per-user; per-universe fits Codex's
   worldbuilding scoping better.)
3. **Public reader:** should document-level line spacing (and page setup generally) apply
   to the published reading pages, or stay independent?
4. **Marker grammar:** confirm paragraph-style markers sit at paragraph start like
   alignment, and how a paragraph that is both aligned and styled is written
   (e.g. `\center \verse ...`).
