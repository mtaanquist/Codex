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
`.chip`, `.pill`, `.empty`, `Icon.svelte`). Check all three themes. Do not
invent a new button skin, menu system, modal, or empty state; the codebase
already has too many, and the list of offenders is at the end of this sheet.

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
| Workspace | `.app` grid + `TopBar.svelte` | Write, Plan, Notes, Review (story scope); Plan, Notes (universe scope) |
| Page | `.page-shell` + `PageTopBar.svelte` | Library |
| Settings | `SettingsShell.svelte` + `PageTopBar.svelte` | Account, admin, story settings, universe settings, insights |
| Auth | `AuthShell.svelte` | Sign-in, sign-up, and every email-flow page |

The workspace shell is a three-column grid: structure left (fixed 240px),
work centre, reference right (fixed 280px). Sidebar widths are a settled
decision; resize is deferred. Focus mode (`.app.focus-mode`) hides both
sidebars with `visibility: hidden` so the prose column does not shift.

`TopBar` carries breadcrumbs (Library > Universe > Story), save status,
palette button, notification bell, help, and the user menu. `PageTopBar`
carries a single back link instead of breadcrumbs. The pages that currently
escape all shells (docs, print, guest review, public reader) are known
drift; the fix is scoped in `design-pass-prompts.md`, brief 2. Do not model
a new page on them.

The right sidebar of the workspace shell has up to four tabs with fixed
semantics (see `design.md`): Reference (what is in view), History (what was
in view), Session (how you are working), Assistant (who you are working
with). A tab that does not apply to a mode is hidden, not faked.

## Canonical primitives

The rule for all of them: if the control you need is close to one of these,
use or extend the primitive; if it is genuinely new, add it to the shared
CSS with a considered name and add it to this sheet.

### Buttons

- `.btn` with `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`,
  size modifier `.btn-sm`. Defined in `pages.css`. This is the only general
  button system.
- `.icon-btn` for icon-only buttons (top bars, panel headers). Defined in
  `theme.css`; also styles `a.icon-btn`.
- Scoped exceptions that stay: `.md-tool` (editor toolbar), `.seg-btn`
  (segmented strips), `.rv-btn` family (review surfaces, pending
  consolidation).
- Everything else (`.tool-btn`, `.mini-btn`, `.rb-btn`, `.send-btn`,
  `.card-add`, `.outline-add`, and the rest of the 20+ skins) is legacy.
  Do not use them in new code and do not create new ones.

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

There is no shared modal primitive yet; three hand-rolled ones exist. Until
one is extracted, model a new modal on `ReviewModal.svelte`: token-based
backdrop (`color-mix` over `--bg-canvas`), panel on `--bg-elevated`, footer
buttons using `.btn`. Do not copy `HelpModal`'s hard-coded black backdrop.

### Badges, chips, pills

Three words, three meanings; keep them straight:

- `.badge` - an entity identity mark (image or initial), sized `dot`, `sm`,
  `lg`, rendered by `EntityBadge.svelte`.
- `.chip` - an interactive token: tags, removable filters, add-affordances
  (`.muted`, `.dashed`, `.link`).
- `.pill` - a small static status label (`.pill-accent`).

The dozen other spellings (`.role-tag`, `.nav-badge`, `.rv-type-pill`,
`.tfa-badge`, ...) are scoped legacy; do not add new ones.

### Segmented strips and filters

- `.seg` container with `.seg-btn` items (`.active`, `:disabled`) - the
  mode strip and any exclusive-choice strip. `ModeSwitcher.svelte` is the
  reference use.
- `.rtabs`/`.rtab` in the review workspace is a duplicate of `.seg` and is
  marked for consolidation. Known bug to not replicate: `.seg-btn.active`
  has a light-theme shadow soften; `.rtab.active` lacks it.
- Filter pill rows also exist twice (`.rv-filters` and `.revision-filters`);
  prefer extending `.seg` semantics rather than adding a third.

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

`.empty` (centred, `--text-faint`, 13px) is the primitive. The other eleven
spellings are legacy. An empty state is one short sentence telling the user
what to do, per the writing rules.

### Icons

`Icon.svelte`: a typed name registry (`IconName`), 24px viewBox, 1.8 stroke,
`currentColor`. Colour always comes from the parent's CSS `color`; size
comes from the `size` prop or an ancestor rule (`.btn svg`, `.icon-btn
svg`). Add new icons to the `PATHS` registry in the same style; do not
inline ad-hoc SVG in components.

### Status and feedback

- Save state: the top-bar save pill (`Saving...` / `Saved just now` /
  retry on error).
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
`pages.css`, `admin.css`, `editor.css`, `review.css`, `menus.css`. All
global and unscoped, so a later file silently wins a specificity tie; check
for an existing definition before adding a class.

- `tokens.css` - tokens and base element rules only. No components.
- `theme.css` - the workspace shell and its components (outline rows,
  panels, editor chrome, entity UI).
- `pages.css` - the page/settings shells, buttons, forms, cards, landing.
- `admin.css` - settings and admin surfaces (used by account pages too).
- `editor.css` - CodeMirror-specific rules (mention underlines, hover
  cards, autocomplete popup).
- `review.css` - review surfaces.
- `menus.css` - the shared popover/menu skin.

Component `<style>` blocks are for genuinely local layout only. If a rule
could apply anywhere else, it belongs in the shared files. Never redefine a
shared class inside a component (this currently happens for `.btn-sm`,
`.mini-btn`, `.field-hint`, and two entire blocks; see below).

## New page checklist

1. Pick the shell; wire the top bar (breadcrumbs or back link) and the
   palette/bell/help/user cluster that shell provides.
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

Dead CSS (defined, zero call sites, ~400 lines): `.icon-button`,
`.btn-mini`, `.add-mini`, the whole `.ctx-menu` system, `.settings-nav`,
`.note-card` block, `.storage-bar`/`.usage-bar` blocks, `.goal-bar`,
`.ac-menu`/`.ac-item`, `.entity-pop`, `.quick-select` block, the `.kbd`
class.

Duplicated definitions (later file or component style wins): the assistant
chat block (`theme.css` and `AssistantPanel.svelte`), the `.insp-*`
inspector (`theme.css` and `EntityCard.svelte`), the kanban CSS
(`SceneBoard.svelte` and `StoryBoard.svelte` are copy-pasted),
`.revision-dot`, `.brand-name`, `.mini-btn`, `.rb-btn`, `.btn-sm`,
`.field-hint`, `.ent-row`, `.chapter-row`/`.scene-row`.

Hard-coded colours that bypass tokens: the `.select` caret SVG stroke, the
`.swatch-custom` gradient hexes, the `color-mix(... #1b2a55)` navy in three
places, the QR block's fixed light/dark backgrounds, `.toggle-track`'s
`#fff` knob, a dozen bare `color: #fff` where `--accent-contrast` exists,
inline `style="color: #fff"` on both top-bar brand marks, and the
mismatched `var(--token, #hex)` fallbacks.

Parallel systems pending a decision: `.seg` vs `.rtabs`; `.rv-filters` vs
`.revision-filters`; `.saved` vs `.save-status`; `FormStatus.svelte` vs
`.form-error`/`.form-saved`; three modal implementations; twelve empty
states; six avatar classes.

The visual side of consolidating these is brief 4 in
`design-pass-prompts.md`; the code side is a follow-up refactor once that
brief lands.

## Component index

Reusable primitives: `Icon`, `EntityBadge`, `EntityQuickCard`, `TagInput`,
`ModeSwitcher`, `ThemeToggle`, `PaletteButton`, `SidebarSearch`,
`HelpLink`, `FormStatus`, `ReviewAvatar`, `ReviewReplyForm`,
`ReviewReplyRow`, `ReviewMarginRail`, `ReviewSelectionToolbar`.

Shared composites: `TopBar`, `PageTopBar`, `SettingsShell`, `AuthShell`,
`UserMenu`, `NotificationBell`, `ActivityCenter`, `ViewMenu`,
`EditorToolbar`, `SelectionMenu`, `NotesSidebar`, `PlanSidebar`,
`StoryOutline`, `StoryRowMenu`, `RevisionHistory`, `EntityBadgePicker`,
`EntityRelationships`, `ReviewSurface`, `ReviewPanel`, `ReviewCommentCard`,
`ReviewSuggestionCard`, `ReviewSceneHead`, `AssistantProposal`.

Single-purpose surfaces: `Landing`, `CommandPalette`, `HelpModal`,
`SceneEditor`, `StoryPreview`, `NoteEditor`, `RevisionPreview`,
`SessionPanel`, `ExportPanel`, `AssistantPanel`, `CoauthorPanel`,
`ReviewWorkspace`, `ReviewEditor`, `ReviewModal`, `EntityEditor`,
`EntityCard`, `RelationshipWeb`, `SceneBoard`, `StoryBoard`.
