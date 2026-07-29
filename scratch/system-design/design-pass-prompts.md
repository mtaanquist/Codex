# Visual design pass - briefs for Claude Design

Status: drafted 2026-07-29. Prompts to run in Claude Design, one session per
brief. Each session should produce an updated prototype in the usual handoff
format (see "Handoff format" below), which then gets ported to Svelte the same
way the original design was.

The goal of the pass is cohesion and intuitiveness, not novelty. The app's
look is settled and liked; the work is tightening the seams: one navigation
model, one shell family, screens that were built later brought back in line
with the system, and a landing page that earns its place.

Companion document: `design-system.md`, the components sheet written from a
full audit of the shipped CSS and components. It lists the canonical
primitives, the legacy skins, and the known drift; briefs 3 and 4 draw
directly on it.

## How to use this document

1. Start every Claude Design session with the "Shared context" block below,
   pasted verbatim, plus the current `tokens.css` and `theme.css` from
   `src/lib/styles/` so the session works from the real system.
2. Follow with one brief. Do not run two briefs in one session; each brief is
   scoped to produce one reviewable handoff.
3. Screenshots of the current screens help more than descriptions. The list
   of screens worth capturing is at the end of this document.

## Shared context (paste into every session)

Codex is a self-hosted writing workspace for long-form creative work: novels,
serials, worldbuilding, TTRPG campaigns. It is calm, text-first, and dense in
the way a good tool is dense: no marketing gloss inside the app, no decoration
that does not carry information. The UI font is Hanken Grotesk, prose is set
in a serif (Spectral/Literata), and the palette is built from CSS custom
properties with three themes (dark, light, warm) selected by a `data-theme`
attribute. Category colours (ten tints) mark entity kinds; four status
colours (draft, revised, final, outline) mark scene state. All colour,
spacing, and radius values come from tokens; nothing is hardcoded.

The app has four page shells:

- Workspace: a three-column layout (structure left, work centre, reference
  right) with a top bar carrying breadcrumbs (Library > Universe > Story),
  save status, command palette button, notifications, help, and user menu.
  Used by Write, Plan, Notes, and Review at story scope, and Plan and Notes
  at universe scope. A segmented "mode strip" (Write | Plan | Notes | Review)
  sits at the top of the left sidebar.
- Page shell: single-column pages (the library) with a simpler top bar that
  has a one-level back link instead of breadcrumbs.
- Settings shell: two-column settings pages (account, admin, story settings,
  universe settings) with a sectioned sidebar nav.
- Auth shell: the landing chrome (brand, theme toggle, footer) around a
  centred card, used by sign-in, sign-up, and every email-flow page.

Constraints that hold for every brief:

- Work within the existing tokens. Propose a new token only if a real gap
  exists, and say so explicitly; never inline a raw colour or size.
- All three themes must work. Check dark, light, and warm.
- Plain ASCII punctuation in all UI text: no em dashes, no curly quotes.
- Help and instruction text addresses someone who has never seen the app;
  tell them what to do, and leave the reasoning out.
- The editor in the prototype is a mock; the real editor is CodeMirror 6.
  Design editor-adjacent chrome freely, but do not design inside-the-editor
  behaviour beyond what already exists.
- Keyboard reachability and visible focus are requirements, not polish.

## Brief 1: Landing page

The current landing page is a hero ("Plan the world. / Write the book."),
four one-word feature markers (Plan, Write, Remember, Yours) with a sentence
each, two CTAs (Sign in, Request access), and a one-line footer
(Self-hosted - Invite-only). No imagery, no product shots.

Redesign it to do three jobs the current page does not:

1. Show the product. The three-column workspace is the pitch; a reader
   should see it, not read about it. Consider a stylised, token-accurate
   rendering of the workspace (not a raster screenshot) so it stays crisp
   in all three themes.
2. Speak to all three audiences: the novelist, the worldbuilder, and the
   TTRPG designer or DM. They overlap, and the page should show one tool
   with three postures rather than three feature lists.
3. Explain the model honestly: self-hosted or hosted, same code, invite
   gated, your words exportable as markdown, no AI in the writing loop.
   These are differentiators for the audience this tool wants; state them
   plainly rather than burying them in the footer.

Keep: the tone (quiet confidence, no superlatives), the serif hero, the
existing auth shell chrome so sign-in and sign-up still feel like part of
the same surface. The page must also respect the signup mode: when sign-up
is closed the Request access CTA disappears, and the page has to still make
sense with only Sign in.

Out of scope: pricing (there is none), testimonials, screenshots of real
user content.

## Brief 2: Navigation and wayfinding

The workspace is liked; getting between its parts is where the seams show.
A code audit found these concrete problems. Solve them as one system, not
as sixteen patches:

- Two different top bars (workspace breadcrumbs vs single back link), plus
  two more one-off bars on the print page and the guest review page, and no
  bar at all on the help pages and public reader pages.
- The breadcrumb is ambiguous: the story-title crumb links to story
  settings (while a gear two icons away goes to the same place), and the
  universe crumb goes to plan when a story is open but to universe settings
  when it is not.
- The mode strip silently changes size: four modes at story scope, two at
  universe scope, four-with-three-disabled for guest reviewers.
- Universe insights is nearly unreachable: only a link inside the Session
  tab and a command palette entry.
- Dead ends: the print page has no way back, the docs pages drop the user
  out of the app chrome entirely, and the guest review page has no help or
  theme control.
- Help exists in two presentations: a modal (from the ? button) and a bare
  standalone page (from the palette and footer links), for the same
  articles.

Deliver:

1. One navigation model: define what the top bar shows on every page type,
   when breadcrumbs appear, what each crumb links to, and where settings
   entry points live. The rule should be statable in a sentence or two.
2. A consistent mode strip: decide how it behaves at universe scope and for
   guests (fewer items, disabled items, or a different control) and apply
   it everywhere.
3. A home for insights, docs, and print inside that model.
4. The guest review chrome as a deliberate reduced shell rather than an
   accident: what a guest can see and reach, styled as part of the family.

Constraint: do not merge Write and Review; they stay peer modes (settled
decision, see write-review-unification.md). Sidebar widths are fixed (240
left, 280 right); resize is out of scope.

## Brief 3: Shell and secondary-surface cohesion

The core workspace held together; the surfaces added later drifted. Bring
them back into the system:

- The right-pane tab strip differs per mode: up to four tabs on Write,
  three or four on Plan, two on Review, and a fake non-interactive
  "History" pill on Notes. Define the tab strip once: which tabs exist in
  which mode, what happens when a tab does not apply (hide it), and one
  label for the Assistant tab (it currently varies by page).
- The settings family (account, admin, story settings, universe settings,
  insights) shares a shell but insights uses its sidebar for in-page
  anchors while every sibling uses it for routes. Decide what insights is:
  a settings section, or a workspace view with the standard right-pane
  treatment.
- The public reader pages (`/@handle` shelf and the story reader) hardcode
  their own serif and colours instead of using tokens, and carry no brand
  or footer. Design them as the outward face of the product: reader-first,
  minimal, but recognisably Codex, honouring the reader's theme preference
  and WCAG AA.
- The library screen has three different creation affordances (header
  button, per-universe card, standalone card) plus a text link for import.
  Rationalise into one pattern with variants.

Deliver a component-level spec for each: the tab strip, the settings
sidebar, the reader chrome, and the creation affordance, each shown in all
three themes.

## Brief 4: Primitive consolidation sheet

A code audit (see `design-system.md`) found the system underneath the
screens has drifted: 20+ button skins where one system (`.btn`) was
intended, 13+ badge/pill spellings, 9 menu implementations where 2 use the
shared popover skin, three hand-rolled modals with three different
backdrops, and a dozen empty-state styles. The screens look cohesive; the
vocabulary underneath is not, and every new page risks widening the gap.

Produce a single-page components sheet as a designed artifact: every
canonical primitive rendered in all its variants and states, in all three
themes, on one reference page. Specifically:

1. Buttons: `.btn` primary/secondary/ghost/danger, default and `.btn-sm`,
   plus `.icon-btn`, in rest/hover/active/disabled/focus states. Decide
   whether the review surface's `.rv-btn` variants become `.btn` variants
   or stay a scoped family, and show the result.
2. One modal primitive: backdrop, panel, header, footer with `.btn`
   actions, close affordance, at two sizes. The palette, review modal, and
   help modal should all be expressible with it.
3. One segmented strip (`.seg`) covering the mode strip, the review tabs,
   and the filter pill rows, including disabled and counted (badge) items.
4. Badge/chip/pill: confirm the three-way split (identity badge,
   interactive chip, static pill) and render the full set, including the
   entity badge at its three sizes with image and initial forms.
5. Empty states: one pattern with icon/no-icon and action/no-action
   variants.
6. Form kit: field, label, hint, input, textarea, select (with a
   token-driven caret), toggle row, error and success status lines, and
   the focus ring, shown once as the single source.
7. A type ramp: today's sizes are ad hoc (13.5px, 12.5px, 11.5px); propose
   a small named scale that covers the existing screens without visibly
   changing them.

For each primitive, the sheet should state in a line what it is for and
when not to use it, in the sheet's own voice, since this page doubles as
the reference given to coding agents. Nothing on this page should require
new tokens beyond the type ramp; where a current screen contradicts the
sheet, the sheet wins and the screen is listed as a migration.

## Handoff format

Same as the original handoff: a no-build React prototype (`codex.html`
mounting `src/*.jsx` with Babel over fake data on `window.CODEX_DATA`),
with the design system in `tokens.css`, `theme.css`, and `pages.css`.
Changed or new CSS goes in those files, not inline. Reference screenshots
accompany the prototype. The prototype is a visual and behaviour spec; the
Svelte implementation reimplements it rather than transplanting the JSX.

## Screens to capture before starting

1. Landing page, signed out
2. Library, signed in
3. Write view with a scene open (the three-column workspace)
4. Continuous whole-story view
5. Plan at story scope with the scene board
6. Plan at universe scope with an entity open (relationships visible)
7. Review workspace as the author
8. Command palette open over the editor
9. Story settings (stands in for the whole settings family)
10. Universe insights
11. Public reader page for a published story

Capture each in dark and light at minimum; warm where colour decisions are
being made.
