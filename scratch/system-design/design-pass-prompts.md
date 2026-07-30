# Visual design pass - session prompts for Claude Design

Status: rewritten 2026-07-29 as paste-ready prompts. The Codex
design-system project on claude.ai/design holds the shipped CSS
(`styles/`), the preview cards, and the registered fonts, so sessions see
the real system; nothing needs pasting besides these prompts.

The goal of the pass is cohesion and intuitiveness, not novelty. The
app's look is settled and liked; the work is tightening the seams.
Companion document: `design-system.md`, the components sheet audited from
the shipped code. The prompts below restate what a session needs; the
sheet is the fuller reference.

## How to run the pass

- Run order: primitives, then navigation, then secondary surfaces, then
  landing. The primitives sheet settles the vocabulary the other
  sessions design with, and the landing page runs last so its workspace
  render shows the finished chrome.
- One prompt per session, in the Codex project. Iterate in the session
  until it looks right; only then hand the result back for porting.
- Before the navigation and secondary-surface sessions, capture current
  screenshots (list at the end) and attach the relevant ones.
- After each session lands and is ported, re-sync the kit so the next
  session designs against the updated system.

## Session 1: Primitives

Paste everything in the block below.

```text
Codex is a self-hosted writing workspace for long-form creative work:
novels, serials, worldbuilding, TTRPG campaigns. The app is calm and
text-first; nothing decorative that does not carry information. This
project's Design System pane shows the shipped primitives, rendered from
the app's real CSS in styles/ with the real fonts.

Constraints for everything you produce:
- Use only the tokens in styles/tokens.css for colour, radius, spacing,
  and fonts. If a real gap needs a new token, propose it explicitly.
- Every design must work in all three themes: html[data-theme] set to
  dark, light, and warm. Check all three.
- Plain ASCII punctuation in UI text: no em dashes, no curly quotes.
- Keyboard reachability and visible focus are requirements.
- Deliver as self-contained HTML pages added to this project, built like
  the existing cards (link styles/ and kit.css, render the three themes
  side by side), plus a short written note of the decisions and their
  migration impact.

The task: the app's screens look cohesive, but the vocabulary underneath
has drifted: an audit found 20+ button skins where one system (.btn) was
intended, 13+ badge and pill spellings, 9 menu implementations, three
hand-rolled modals with three different backdrops, and a dozen
empty-state styles. Produce a single consolidated primitives sheet - the
one page that becomes the reference for every future screen:

1. Buttons: the .btn family (primary, secondary, ghost, danger; default
   and small) plus icon-btn, in rest, hover, active, disabled, and focus
   states. Decide whether the review surface's rv-btn variants fold into
   .btn or stay a scoped family, and show the outcome.
2. One modal primitive: backdrop, panel, header, footer with .btn
   actions, close affordance, two sizes. The command palette, the review
   modal, and the help modal must all be expressible with it.
3. One segmented strip (.seg) covering the mode strip, the review tabs,
   and the filter pill rows, including disabled items and items carrying
   a count.
4. Badge, chip, pill: confirm the three-way split (identity badge,
   interactive chip, static pill) and render the full set, including the
   entity badge at dot, small, and large, in image and initial forms.
5. Empty states: one pattern, with and without an icon, with and without
   an action.
6. The form kit: field, label, hint, input, textarea, select with a
   token-driven caret, toggle row, error and success lines, and the
   focus ring, shown once as the single source.
7. A type ramp: current sizes are ad hoc (15, 13.5, 12.5, 11.5px).
   Propose a small named scale that covers the existing screens without
   visibly changing them.

For each primitive, add one line in the sheet's own voice saying what it
is for and when not to use it; this page doubles as the reference given
to coding agents. Nothing here should need new tokens beyond the type
ramp. Where a current screen contradicts the sheet, the sheet wins; list
that screen as a migration in the decisions note.
```

## Session 2: Navigation and wayfinding

Attach current screenshots of the write view, library, story settings,
docs, print, and guest review pages, then paste the block.

```text
Codex is a self-hosted writing workspace for long-form creative work:
novels, serials, worldbuilding, TTRPG campaigns. This project's Design
System pane shows the shipped primitives (updated with the consolidated
set from the primitives session); styles/ holds the real CSS.

Constraints: tokens only; all three themes (data-theme dark, light,
warm); ASCII punctuation in UI text; help text tells a first-time user
what to do; keyboard reachable with visible focus. Sidebar widths are
fixed (240 left, 280 right). Write and Review stay separate peer modes -
that is settled, do not merge them. Deliver as self-contained HTML pages
in this project (one per key screen state) plus a decisions note stating
the navigation rules in plain sentences.

The task: the workspace is liked; moving between its parts is where the
seams show. A code audit found these problems. Solve them as one system,
not as patches:

- Two different top bars (workspace breadcrumbs vs a single back link),
  two more one-off bars on the print and guest review pages, and no bar
  at all on the help pages and public reader pages.
- The breadcrumb is ambiguous: the story-title crumb links to story
  settings while a gear two icons away goes to the same place, and the
  universe crumb goes to plan when a story is open but to universe
  settings when it is not.
- The mode strip changes size silently: four modes at story scope, two
  at universe scope, four-with-three-disabled for guest reviewers.
- Universe insights is nearly unreachable: one link inside the Session
  tab and a command palette entry.
- Dead ends: the print page has no way back, the docs pages drop the
  user out of the app chrome entirely, and guest review has no help or
  theme control.
- Help has two presentations for the same articles: a modal from the ?
  button, and a bare standalone page from the palette and footer links.

Deliver:
1. One navigation model: what the top bar shows on every page type, when
   breadcrumbs appear, what each crumb links to, where settings entry
   points live. The rule must be statable in a sentence or two.
2. A consistent mode strip: how it behaves at universe scope and for
   guests, applied everywhere.
3. A home for insights, docs, and print inside that model.
4. The guest review chrome as a deliberate reduced shell, styled as part
   of the family.
```

## Session 3: Secondary surfaces

Attach current screenshots of the notes view, review workspace, story
settings, universe insights, library, and public reader pages, then
paste the block.

```text
Codex is a self-hosted writing workspace for long-form creative work:
novels, serials, worldbuilding, TTRPG campaigns. This project's Design
System pane shows the consolidated primitives; styles/ holds the real
CSS. The navigation model from the previous session applies.

Constraints: tokens only; all three themes (data-theme dark, light,
warm); ASCII punctuation; help text tells a first-time user what to do;
keyboard reachable with visible focus; the reader pages must meet WCAG
2.1 AA. Deliver as self-contained HTML pages in this project plus a
decisions note.

The task: the core workspace held together; surfaces added later
drifted. Bring them back into the system:

- The right-pane tab strip differs per mode: up to four tabs on Write,
  three or four on Plan, two on Review, and a fake non-interactive
  History pill on Notes. Define the strip once: which tabs exist in
  which mode, hide a tab that does not apply, and settle one label for
  the Assistant tab (it currently varies by page).
- The settings family (account, admin, story settings, universe
  settings, insights) shares a shell, but insights uses its sidebar for
  in-page anchors while every sibling uses it for routes. Decide what
  insights is: a settings section, or a workspace view with the standard
  right-pane treatment.
- The public reader pages (the /@handle shelf and the story reader)
  hardcode their own serif and colours instead of tokens and carry no
  brand or footer. Design them as the outward face of the product:
  reader-first, minimal, recognisably Codex, honouring the reader's
  theme preference.
- The library has three creation affordances on one screen (header
  button, per-universe card, standalone card) plus a text link for
  import. Rationalise into one pattern with variants.
```

## Session 4: Landing page

Run last, so the workspace render shows the finished chrome. Attach a
screenshot of the redesigned write view, then paste the block.

```text
Codex is a self-hosted writing workspace for long-form creative work:
novels, serials, worldbuilding, TTRPG campaigns. This project's Design
System pane shows the consolidated primitives; styles/ holds the real
CSS. The tone is quiet confidence: no superlatives, no marketing gloss.

Constraints: tokens only; all three themes; ASCII punctuation; keyboard
reachable with visible focus. The auth chrome (brand, theme toggle,
footer) stays, so sign-in and sign-up remain visually part of the same
surface. The page must also work when sign-up is closed: the Request
access button disappears and Sign in stands alone. Deliver as
self-contained HTML pages in this project plus a decisions note. Out of
scope: pricing (there is none), testimonials, screenshots of real user
content.

The task: the current landing page is a serif hero ("Plan the world. /
Write the book."), four one-word feature markers with a sentence each,
two buttons, and a one-line footer. Redesign it to do three jobs the
current page does not:

1. Show the product. The three-column workspace is the pitch; a reader
   should see it, not read about it. Prefer a stylised, token-accurate
   rendering of the workspace (not a raster screenshot) so it stays
   crisp in all three themes; base it on the attached screenshot of the
   current chrome.
2. Speak to all three audiences - the novelist, the worldbuilder, the
   TTRPG designer or DM - as one tool with three postures, not three
   feature lists.
3. State the model plainly: self-hosted or hosted, same code; invite
   gated; your words exportable as markdown; no AI unbidden and fully
   usable with it off. These are differentiators for this audience;
   they belong on the page, not in the footer.
```

## Porting and handoff

Results come back as pages in the Codex project; pull them with
DesignSync and port to Svelte, reimplementing rather than transplanting.
CSS decisions land in `src/lib/styles/`; the components sheet
(`design-system.md`) and the kit cards update in the same change, and
the kit re-syncs so the project reflects the new canon. The older
`scratch/app-design/` prototype handoff remains valid if a session is
run outside the project.

## Screens to capture

1. Landing page, signed out
2. Library, signed in
3. Write view with a scene open
4. Continuous whole-story view
5. Plan at story scope with the scene board
6. Plan at universe scope with an entity open
7. Review workspace as the author
8. Command palette open over the editor
9. Story settings
10. Universe insights
11. Docs index and one article
12. Print view
13. Guest review page
14. Public reader page for a published story

Dark and light at minimum; warm where colour decisions are being made.
