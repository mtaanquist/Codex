# Codex design system - components sheet

Status: written 2026-07-29 from a full audit of `src/lib/styles/` and
`src/lib/components/`. This is the canonical reference for anyone (person or
agent) building a new page or changing an existing one. It says which
primitives are canon, which are legacy, and which patterns must not be
copied. When the code and this sheet disagree, fix one of them; do not let
them drift apart silently.

Companion documents: `design.md` (product intent and page semantics),
`design-pass-prompts.md` (the visual design pass briefs).

## The one-paragraph version

Use tokens for every colour, radius, and font. Wrap every page in one of the
four shells. Build controls from the canonical primitives below (`.btn`,
`.icon-btn`, `.field`/`.input`, `.popover`/`.menu-item`, `.seg`, `.badge`,
`.chip`, `.pill`, `.modal-panel`, `.empty-state`, `Icon.svelte`). Check all
three themes. Do not invent a new button skin, menu system, modal, or empty
state; the consolidation that removed the previous crop is described at the
end of this sheet.

## Tokens

Source of truth: `src/lib/styles/tokens.css`. Themes are selected by a
`data-theme` attribute on `<html>` (`dark`, `light`, `warm`), set before
first paint by an inline script in `src/app.html`. Density
(`data-density="compact"`) tightens `--row-h` and `--pane-pad`. The accent
is a user preference applied as an inline `--accent` on `<html>`.

Fonts:

- `--font-ui` (Hanken Grotesk) for all chrome.
- `--font-serif` (Spectral) for prose and display headings; the editor's
  content face is `--font-content`, which the user can switch.
- `--font-mono` (JetBrains Mono) for code and identifiers.

Type ramp, seven steps covering every chrome and prose size. Use a step
rather than a raw pixel value; the serif display sizes stay per-surface
decisions, because a story title is not a card title.

- `--text-micro` (11px) - segment counts, uppercase eyebrows.
- `--text-meta` (11.5px) - field hints, timestamps.
- `--text-sm` (12.5px) - small buttons, labels, secondary rows.
- `--text-base` (13.5px) - the default chrome size.
- `--text-lg` (15px) - modal titles, search fields.
- `--text-prose-sm` (14.5px) / `--text-prose` (19px) - reading surfaces.

Surfaces, from back to front:

- `--bg` - the page background.
- `--bg-elevated` - raised chrome: top bars, dropdowns, popovers.
- `--bg-panel` - the left and right sidebars.
- `--bg-card` - cards sitting on a surface.
- `--bg-canvas` - the prose canvas (editor centre column, reading views).
- `--bg-inset` - wells and recessed areas inside a surface.
- `--bg-hover` / `--bg-active` - interactive state fills; translucent so
  they work on any surface.

Text tiers: `--text` (primary), `--text-muted` (secondary), `--text-faint`
(tertiary and empty states). Borders: `--border` (default), `--border-strong`
(emphasis, scrollbar thumbs).

Accent family: `--accent` (fills), `--accent-contrast` (text on accent
fills; use this, never `#fff`), `--accent-soft` (selection, focus glow,
soft fills), `--accent-line` (focused borders).

Assets and contrast:

- `--danger-contrast` - text on a `--danger` fill (`.btn-danger`). The
  danger twin of `--accent-contrast`; never write `#fff` on danger.
- `--select-caret` - the `.select` caret, declared per theme. A data URL
  cannot read a custom property, so each theme carries its own faint stroke
  colour in the asset. `.select` is the only consumer.

Meaning colours:

- Status: `--status-outline`, `--status-draft`, `--status-revised`,
  `--status-final`. Scene and story state only.
- Danger: `--danger`, `--danger-soft`. Destructive actions and errors only.
- Category tints: `--cat-violet`, `--cat-rose`, `--cat-green`, `--cat-blue`,
  `--cat-amber`, `--cat-red`, `--cat-lime`, `--cat-teal`, `--cat-cyan`,
  `--cat-fuchsia`. Entity categories and anything the user colour-codes.

Geometry: `--radius-sm` (6px), `--radius`/`--radius-md` (9px), `--radius-lg`
(14px); spacing scale `--space-1` through `--space-10` (4 to 44px);
`--row-h` for list rows; `--content-max` for the prose column.

Rules:

- Never write a raw colour value. If a needed colour does not exist as a
  token, that is a design decision to raise, not a hex to inline.
- Do not write `var(--token, #fallback)`. The tokens are always defined;
  fallbacks rot (the codebase currently has three different fallbacks for
  `--danger`, all wrong in at least one theme).
- Do not branch on `[data-theme='...']` in CSS. Tokens carry the theme. The
  single sanctioned exception is softening a box-shadow that reads too heavy
  on light backgrounds.
- Derive transparent tints with `color-mix(in oklab, var(--token) N%,
  transparent)`, the way `--accent-soft` and `--danger-soft` are built.

## Shells

Every page uses exactly one of these four wrappers. Do not build a fifth.

| Shell | Component(s) | Used by |
|---|---|---|
| Workspace | `.app` grid + `AppBar.svelte` | Write, Plan, Notes, Review (story scope); Plan, Notes (universe scope); help; guest review |
| Page | `.page-shell` + `AppBar.svelte` | Library, print preview, public reading pages |
| Settings | `SettingsShell.svelte` + `AppBar.svelte` | Account, admin, story settings, universe settings, insights |
| Auth | `AuthShell.svelte` | Sign-in, sign-up, and every email-flow page |

The workspace shell is a three-column grid: structure left (fixed 240px),
work centre, reference right (fixed 280px). Sidebar widths are a settled
decision; resize is deferred. Focus mode (`.app.focus-mode`) hides both
sidebars with `visibility: hidden` so the prose column does not shift.

Every one of them wears the same bar; see Chrome below. Nothing escapes a
shell any more: docs, print, guest review and the public reader all carry it.

## Chrome

One navigation bar for every page type, defined in `chrome.css` (imported
last, so it beats the bars it replaced) and rendered by `AppBar.svelte`:
brand, then the path, then the tools, in that order, 52px, `--bg-elevated`,
one bottom border.

Three shells, one family. A shell may drop a tool; none reorders one, and
none adds a second bar.

| Shell | Brand | Path | Tools |
|---|---|---|---|
| `.appbar` (author) | links to your library | Library / Universe / Story / Page, each place a menu | Search, Theme, Help, Notifications, You |
| `.appbar.guest` | lockup, not a link | the one story they were sent, plus a "Review only" pill | Theme, Help, "Reviewing as ..." |
| `.appbar.reader` | links to Codex | the story and its author, as text | Theme, Help |

The path and its crumb menus:

- The path is `Library / Universe / Story / Page`. Every crumb opens that
  place's home; the last crumb is the page you are on and does not link.
- **Crumbs go to homes.** The story crumb opens the story's Write mode; the
  universe crumb opens the universe's Plan, always, whether or not a story
  is open.
- **A place in the path is a menu; a page in the path is text.** The
  universe and story crumbs are `.crumb-menu` buttons carrying a caret. The
  menu's first item goes to the place itself ("Go to the universe", "Go to
  the story") and is ticked when you are already there; below it sit that
  place's own things. Crumbs for pages (Insights, Print preview, a help
  article) are plain current text, because nothing belongs to them.
- There is no gear anywhere in the chrome, and no icon-only destination.
- Menus compose the shared `.popover`/`.menu-item` skin, carry
  `aria-haspopup`/`aria-expanded`, tick the current page with
  `aria-current="page"`, and close on outside pointerdown or Escape through
  the shared `dismiss` action.
- Paths are built by `$lib/chrome.ts` (`libraryCrumb`, `universeCrumb`,
  `storyCrumb`, `pageCrumb`, `storyPath`, `universePath`), so every screen
  spells the same destinations the same way. Do not hand-roll a path.

Page actions are not bar actions. Anything that acts on the page (Print,
Page setup, Save, New universe) lives in the page header under the bar,
never in the bar.

Tools:

- `.tool-search` is the palette trigger: a labelled button with a `kbd`
  hint, not an icon. Ctrl+K does the same.
- The theme tool cycles dark -> light -> warm (`$lib/theme.ts`,
  `cycleTheme`). A signed-in viewer's choice persists through the appearance
  API; a guest reviewer's and a reader's is kept in localStorage only.
- The `?` is a tool that is a place, not a popup: it navigates to the help
  pages, lights up with `aria-current="page"` while you are there, and takes
  you back to where you were when pressed again. There is no help modal.

The left slot is always 240px, whatever fills it:

- **The mode strip is always four.** Write, Plan, Notes, Review, same order,
  same width, wherever it appears; it never resizes silently.
  `ModeSwitcher.svelte` is the only implementation. At universe scope Write
  and Review stay live and open the universe's story list. For a guest,
  three are `aria-disabled` and stay in place. Where a mode is unavailable,
  one `.mode-note` line under the strip says why: rendered, not a tooltip,
  so it is readable by keyboard and by screen reader. The two lines live as
  `UNIVERSE_MODE_NOTE` and `GUEST_MODE_NOTE` in `$lib/chrome.ts`.
- Where there is no mode at all (settings, insights, print, help) the same
  slot holds that page's own section list: `.side-nav`, with
  `.side-nav-label` group headings, `.side-head` for the identity block, and
  `aria-current="page"` on the open item. In-page anchors are a sanctioned
  use of `.side-nav`.

The command palette stays the fast path to everything, but it is a shortcut
to this model, never a substitute for it: anything reachable only from the
palette is a bug.

The right sidebar of the workspace shell has up to four tabs with fixed
semantics (see `design.md`): Reference (what is in view), History (what was
in view), Session (how you are working), Assistant (who you are working
with). A tab that does not apply to a mode is hidden, not faked.

## Canonical primitives

The rule for all of them: if the control you need is close to one of these,
use or extend the primitive; if it is genuinely new, add it to the shared
CSS with a considered name and add it to this sheet.

Forced-state hooks: every state rule in the shared CSS also matches
`.is-hover`, `.is-active`, or `.is-focus` beside the real pseudo-state.
These exist for one reason only, so the primitives sheet can render a full
state matrix from the shipped declarations instead of restating them, which
is how the drift started. Product Svelte code must never use them; if a
component needs to look hovered, that is a real state and needs a real
class. One pre-existing exception is grandfathered: `EditorToolbar` and
`ViewMenu` put `.is-active` on `.md-tool`, which predates the hooks. It
does not collide, because every hook selector is compound and needs the
primitive's own class too, but do not copy the pattern.

### Buttons

- `.btn` with `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`,
  `.btn-accept`, size modifier `.btn-sm`. Defined in `pages.css`. This is
  the only general button system.
- `.btn-accept` is the affirmative decision (accept a suggestion, approve a
  pass), built on `--status-final`. It is a variant, not a second family.
- Every variant carries `:hover:not(:disabled)`, `:active`,
  `:focus-visible`, and `:disabled` at 0.45 opacity. Disabled buttons do
  not light up on hover.
- `.icon-btn` for icon-only buttons, 32px in chrome (top bars, panel
  headers). `.icon-btn.sm` is 28px, for inside cards, panel headers and
  modal headers where a 32px target would crowd the row. `.icon-btn.danger`
  tints the hover for a destructive action. Defined in `theme.css`; also
  styles `a.icon-btn`. There are two icon sizes and no third.
- Scoped exceptions that stay: `.md-tool` (editor toolbar), `.seg-btn`
  (segmented strips).
- An icon-only button always carries an `aria-label`.

### Forms

- Wrapper: `.field` with a `<label>`, optional `.field-hint`, laid out with
  `.field-grid` when two-up. Action row: `.settings-actions`.
- Controls: `.input`, `.textarea`, `.select`, `.toggle` inside `.toggle-row`.
  The focus ring (accent border plus `--accent-soft` glow) comes from the
  shared rule; never redefine it.
- Inline result messages: the `FormStatus.svelte` component. The older
  `.form-error`/`.form-saved` classes remain in some routes; do not spread
  them further.
- Do not hand-roll a text field. The codebase has 15+ one-off inputs that
  each re-declare the border and focus ring; that list is frozen.

### Menus and popovers

- `.popover` panel with `.menu-item` rows (plus `.danger`, `:disabled`,
  `.is-current`). Defined in `menus.css`, which documents the intent. Used
  by the row menu and view menu; every new dropdown uses it.
- The avatar dropdown (`.avatar-dropdown`) is deliberately its own richer
  skin. That exception does not license others.

### Modals

`.modal-backdrop` wrapping a `.modal-panel`, defined in `primitives.css`.
Two sizes and no third: 420px by default, 640px with `.modal-lg` for a list
to scan or a passage to read. The backdrop is derived from `--bg`, so all
three themes dim in their own key; there is no backdrop token and none is
needed. The panel centres by default; `.modal-backdrop.top` anchors it at
14vh for an overlay whose content height changes while open (the command
palette), so the top edge stays still as results come and go.

Structure: `.modal-head` (with `.modal-head-main`, `.modal-title`,
`.modal-sub`, `.modal-kind`), `.modal-body` (add `.rows` when it holds
`.menu-item` rows rather than prose), `.modal-foot` (with
`.modal-foot-note` on the left for a hint or shortcut legend). The close
control is an `.icon-btn.sm`; the primary action sits last in the footer.
A head can carry a `.modal-search` field instead of a title, with
`.modal-head.searching`.

The behaviour is the component's, not the CSS's: Esc closes, focus is
trapped in the panel and returned to the opener, and a backdrop click
closes only when nothing is unsaved. `CommandPalette` and `ReviewModal` are
the two reference uses. Help is not one of them: it is a page, not a modal.

### Badges, chips, pills

Three words, three meanings; keep them straight:

- `.badge` - an entity identity mark (image or initial), sized `dot`, `sm`,
  `lg`, rendered by `EntityBadge.svelte`.
- `.chip` - an interactive token: tags, removable filters, add-affordances
  (`.muted`, `.dashed`, `.link`). `.chip-x` is the remove affordance inside
  a removable chip; it only ever appears inside a `.chip`. A chip whose
  removal needs confirming is not a chip, it is a row with a danger action.
- `.pill` - a small static status label (`.pill-accent`).

A thing that is both a label and a control is a chip, not a pill.

The remaining scoped spellings (`.role-tag`, `.nav-badge`, `.tfa-badge`,
...) are legacy; do not add new ones.

### Segmented strips and filters

- `.seg` container with `.seg-btn` items (`.active`, `:disabled`,
  `:focus-visible`) - the mode strip, the right-panel tabs, the review
  tabs, and any exclusive choice of two to four peers. `.seg.full` stretches
  the items to fill the row. `ModeSwitcher.svelte` is the reference use.
- `.seg-count` is a tally riding inside a `.seg-btn` (open notes, filtered
  results) at `--text-micro`. It is not a second badge family and appears
  nowhere else.
- The line: an exclusive choice is a `.seg`; a multi-select filter row is
  chips.

### Lists, rows, tables

- Real tabular data: `.admin-table` (with `.cell-*` helpers, `.num`
  columns, `.row-actions`).
- Icon-led row lists: `.list-row` with `.list-ic`, `.list-main`,
  `.list-title`, `.list-sub`, `.list-actions`.
- Destructive settings rows: `.danger-group`/`.danger-row`.
- Outline rows (chapters, scenes, entities) share the row CSS in
  `theme.css` (`.chapter-row`, `.scene-row`, `.ent-row`) at `--row-h`.

### Cards

`.story-card` (library), `.admin-card` (settings/admin sections, also used
well outside admin), `.r-card` (right-pane reference blocks), `.rv-card`
(review threads). New reference-pane content should compose `.r-card`;
new settings content composes `.admin-card`.

### Empty states

`.empty-state` is the primitive, defined in `primitives.css`: a centred
column at `--text-faint`, with an optional `.empty-state-icon`, a required
`.empty-state-text`, and an optional `.empty-state-action`. Add `.tight`
inside a right-panel card or a sidebar list, where the full padding would
push the panel into a scroll. An empty state is one short sentence telling
the user what to do, per the writing rules.

### Icons

`Icon.svelte`: a typed name registry (`IconName`), 24px viewBox, 1.8 stroke,
`currentColor`. Colour always comes from the parent's CSS `color`; size
comes from the `size` prop or an ancestor rule (`.btn svg`, `.icon-btn
svg`). Add new icons to the `PATHS` registry in the same style; do not
inline ad-hoc SVG in components.

### Status and feedback

- Save state: the app bar's save pill in the tools cluster (`Saving...` /
  `Saved just now` / retry on error), on the editor pages only.
- Keyboard hints: the `kbd` element (styled globally in `pages.css`).
- Tooltips: native `title` attributes plus `aria-label` for icon-only
  controls. There is no custom tooltip primitive; do not build one ad hoc.
- Banners: `.revision-banner` for the past-revision state is the reference
  pattern for a centre-column banner.

## Writing in the UI

From CLAUDE.md, repeated here because every screen touches it:

- Plain ASCII punctuation everywhere: no em dashes, no curly quotes.
- Help and instruction text tells a first-time user what to do, without
  explaining why the app is built the way it is.
- No jargon or slang in user-facing text.
- User-facing functionality changes come with a check of the help articles
  in `src/lib/docs/`.

## CSS file map

Load order in `src/routes/+layout.svelte`: `tokens.css`, `theme.css`,
`pages.css`, `admin.css`, `editor.css`, `review.css`, `menus.css`,
`primitives.css`. All global and unscoped, so a later file silently wins a
specificity tie; check for an existing definition before adding a class.

- `tokens.css` - tokens and base element rules only. No components.
- `theme.css` - the workspace shell and its components (outline rows,
  panels, editor chrome, entity UI).
- `pages.css` - the page/settings shells, buttons, forms, cards, landing.
- `admin.css` - settings and admin surfaces (used by account pages too).
- `editor.css` - CodeMirror-specific rules (mention underlines, hover
  cards, autocomplete popup).
- `review.css` - review surfaces.
- `menus.css` - the shared popover/menu skin.
- `primitives.css` - loaded last, so it wins over any screen-local skin.
  Holds the families that had no single owner before: the modal, the empty
  state, the chip remove affordance, and the shared focus ring.

Component `<style>` blocks are for genuinely local layout only. If a rule
could apply anywhere else, it belongs in the shared files. Never redefine a
shared class inside a component (this still happens for `.btn-sm` and
`.field-hint`; see below).

## New page checklist

1. Pick the shell; wire `AppBar` with a path built from `$lib/chrome.ts` and
   the tools cluster that shell provides. A new page adds a crumb; it does
   not add a bar.
2. Compose from the canonical primitives above; extend shared CSS if a
   variant is genuinely missing.
3. Tokens only; no raw colours, no `[data-theme]` branches, no token
   fallbacks.
4. Check dark, light, and warm, plus compact density if the page has rows.
5. Keyboard: everything reachable, visible focus, `aria-label` on icon-only
   controls, Escape closes any overlay.
6. Empty, loading, and error states use the shared patterns.
7. UI text follows the writing rules; help articles updated if behaviour
   changed.
8. Update this sheet if you added or changed a primitive.

## Known drift - do not copy, consolidation backlog

Found in the 2026-07 audit. Copying any of these into new code makes the
problem worse; fixing them is scheduled work, not drive-by refactoring.

### Removed in the primitives consolidation

These names no longer exist. They are listed so an older screenshot, branch
or design note that still mentions them can be read; do not reintroduce
them.

- Button skins folded into `.btn` and `.icon-btn`: the whole `.rv-btn`
  family, `.rv-quick-btn`, `.rb-btn`, `.btn-mini`, `.mini-btn`,
  `.tool-btn`, `.send-btn`, `.pop-open`, `.rv-scene-comment`,
  `.rv-acceptall`, `.trash-act`, `.rel-remove`.
- Tab and filter strips folded into `.seg`: `.rtabs`/`.rtab`,
  `.rv-filters`/`.rv-filter`/`.rv-filter-n`, `.rv-mtabs`/`.rv-mtab`/
  `.rv-mtab-n`, `.revision-filter-chip`.
- The three hand-rolled modals folded into `.modal-backdrop`/
  `.modal-panel`: `.palette-*`, `.review-modal*`/`.rm-title`/`.rm-actions`,
  `.help-overlay`/`.help-modal*`/`.help-close`/`.help-eyebrow`.
- Empty states folded into `.empty-state`: `.empty`, `.rv-panel-empty`,
  `.rv-empty-scene`, `.block-empty`, `.trash-empty`, `.search-empty`,
  `.note-empty`, `.bell-empty`, `.web-empty`, `.lane-empty`,
  `.insights-empty`, `.empty-body`.
- Labels and tokens folded into `.pill` and `.chip`: `.rv-type-pill`,
  `.trash-kind`, `.revision-source-kind`, `.rv-sub-chip`, `.pop-chip`,
  the `.note-tag*` family.
- Dead CSS swept at the same time: `.icon-button`, `.add-mini`, the
  `.ctx-menu`/`.ctx-item` system, `.settings-nav`, the `.note-card` block,
  the `.kbd` class (the bare `kbd` element rule stays), `.quick-select`,
  `.storage-bar`/`.usage-bar`, `.goal-bar`, `.ac-menu`/`.ac-item`/
  `.ac-name`/`.ac-kind`, `.entity-pop`.

### Still outstanding

Duplicated definitions (later file or component style wins): the assistant
chat block (`theme.css` and `AssistantPanel.svelte`), the `.insp-*`
inspector (`theme.css` and `EntityCard.svelte`), the kanban CSS
(`SceneBoard.svelte` and `StoryBoard.svelte` are copy-pasted),
`.revision-dot`, `.brand-name`, `.btn-sm`, `.field-hint`, `.ent-row`,
`.chapter-row`/`.scene-row`.

Hard-coded colours that bypass tokens: the `.swatch-custom` gradient hexes,
the QR block's fixed light/dark backgrounds, `.toggle-track`'s `#fff` knob,
the remaining bare `color: #fff` where `--accent-contrast` exists, and
inline `style="color: #fff"` on both top-bar brand marks. The `.select`
caret now reads `--select-caret`, the `#1b2a55` navy is gone, and the
`var(--token, #hex)` fallbacks are cleared from the files the
consolidation touched.

Parallel systems pending a decision: `.saved` vs `.save-status`;
`FormStatus.svelte` vs `.form-error`/`.form-saved`; six avatar classes.

Focus reachability is its own pass: the ring is defined and shared, but the
sidebar rows (`.ent-row`, `.scene-row`, `.chapter-row`) are only reachable
once the drag handlers stop swallowing keyboard events.

## Component index

Reusable primitives: `Icon`, `EntityBadge`, `EntityQuickCard`, `TagInput`,
`ModeSwitcher`, `ThemeToggle`, `CrumbMenu`, `SidebarSearch`,
`HelpLink`, `FormStatus`, `ReviewAvatar`, `ReviewReplyForm`,
`ReviewReplyRow`, `ReviewMarginRail`, `ReviewSelectionToolbar`.

Shared composites: `AppBar`, `SettingsShell`, `DocsShell`, `AuthShell`,
`UserMenu`, `NotificationBell`, `ActivityCenter`, `ViewMenu`,
`EditorToolbar`, `SelectionMenu`, `NotesSidebar`, `PlanSidebar`,
`StoryOutline`, `StoryRowMenu`, `RevisionHistory`, `EntityBadgePicker`,
`EntityRelationships`, `ReviewSurface`, `ReviewPanel`, `ReviewCommentCard`,
`ReviewSuggestionCard`, `ReviewSceneHead`, `AssistantProposal`.

Single-purpose surfaces: `Landing`, `CommandPalette`,
`SceneEditor`, `StoryPreview`, `NoteEditor`, `RevisionPreview`,
`SessionPanel`, `ExportPanel`, `AssistantPanel`, `CoauthorPanel`,
`ReviewWorkspace`, `ReviewEditor`, `ReviewModal`, `EntityEditor`,
`EntityCard`, `RelationshipWeb`, `SceneBoard`, `StoryBoard`.
