# TODO

Working checklist against `scratch/system-design/roadmap.md`. One roadmap step
per line; details live in the roadmap. Cross off as things merge to develop.

## Open

The capability review queue closed 2026-06-06 (items 1-5 all shipped;
see the follow-ups section below). Next up: the next-phase candidates
recorded in the roadmap from the 2026-06-06 capability review (Notes
tab ship-or-hide, goals and deadlines, TTRPG positioning, draft
comparison, front/back matter, a self-host walkthrough, write-path
rate limits, help docs coverage; scene split/merge shipped in
v2.34.0), then Phase 9 (AI) when the author calls it. SillyTavern and
lorebook import was removed from the roadmap outright (2026-06-07,
author's call: no expected use); Phase 9 is now just the LLM work.
Continuous backup (WAL/PITR) stays parked by the roadmap's own
criterion; the timeline view stays parked on the world-calendar
design.

A full-codebase review (2026-06-06, 7 finder passes, every candidate
adversarially verified) found 14 confirmed issues, filed as #182-#195
with severity labels and all fixed the same day across five PRs
(#196-#200), shipped as v2.31.0: the account purge FK blocker and the
suspension/deletion column split (migration 0041), token hygiene
(reset kills pending email changes, pending-only TOTP cancel,
confirm-on-POST email links), the guest reviewer email field, the
suggestion-accept row lock, export path dedup, entity save ordering,
shared mention contexts, the parallel editor load, and single sources
of truth for queue names, enums, and helpers.

A second full-codebase review (2026-06-07, same 7-finder + verify
method) found 18 issues, filed as #202-#218 with severity labels and
all fixed across five PRs (#219-#223): the import zip-bomb caps and the
stale image-paste position (#219); the scanner-consumable reviewer
opt-out, the unrevoked email-change token, and the accept revision left
outside its transaction (#220); the missing per-IP login limit and the
unset ADDRESS_HEADER behind the proxy (#221); the palette-search and
page-load query batching, entity-search indexes (migration 0042), the
cross-universe story-note leak, and the digest re-send on retry (#222);
and the cleanup pass - createCategory colour validation, dead
listPendingUsers, shared entity-save guards, a shared action-error
helper, and a single UUID_BODY fragment (#223). Shipped as v2.32.0.

A third full-codebase review (2026-06-11) filed 25 issues (#399-#423:
six bugs, the rest hardening and consolidation), all fixed the same
day across six PRs (#424, #427-#429, #431, #432) and shipped as
v3.4.3 (the bug fixes) and v3.4.4 (the hardening): the export-purge
leak, the merge-seam marker pin, readJson/isUuid/rate-limit sweeps,
three review.ts races (migration 0061), LLM tool gating and prompt
fencing, the shared autosave queue and dismiss action, the entity-save
and assistant-route consolidation, the dead-probe removal, the review
screen dedup, and the story page split (1840 to ~1020 lines).

Operator feedback batch (2026-06-07), three PRs: the admin shell
polish - a shared PageTopBar for the static pages (app icon and
palette everywhere, fixing the library page's missing Admin panel
menu item), ?section= URLs with admin palette entries, and the 60ch
text cap removed inside bordered admin cards (#253); the sign-up mode
setting - none / invite only / require approval (default) / open,
enforced in registerUser and reflected on the signup page, login link,
and landing CTA (#254); and backup and asset storage configurable in
the admin panel - app_settings rows with encrypted secrets seeded by
the env vars, test-connection probes, live backup rescheduling, and a
migrate-assets worker job that copies stored objects when asset
storage moves to a new bucket or host (#255). A follow-up replaced the
template favicon with the brand mark, tinted by the accent colour and
updated live with the appearance settings (#256). Shipped as v2.33.0.

Writing and planning feedback batch (2026-06-07), nine PRs plus a
hotfix: quick fixes - editor context menu over the whole pane,
"Colour group" naming for the character/place category field (it
drives the sidebar tints), the no-colour swatch, a New story form on
the plan board, and appears-in snippets that jump to the mention's
offset (#258); the entity details grid edited one cell at a time
(#260); browser-back returning to the editor spot via a page snapshot
(#261); aliases on places plus spellcheck=false on known mentions
(#262, migration 0046); a category flyout on the selection menu's lore
item (#263); plain-prose entity descriptions (#264); standalone
stories under a lazily created per-owner universe (#265, migration
0047); scene split at the cursor and sidebar merge (#266); and
per-paragraph alignment stored as \center / \right / \justify markers
rendered across editor, reading pages, print, EPUB, and PDF (#267).
The worker also learned to tolerate a fresh database when reading
backup settings at boot, a v2.33.0 boot race (#259). Shipped as
v2.34.0.

Two follow-ups the same day: three more page loads (story editor,
story plan, universe plan) stopped shadowing the layout's user shape,
which had been hiding the Admin panel menu item and the admin palette
entries on those pages (#269); and a manual admin approval now waives
a still-unconfirmed email - the operator's vouch outranks the emailed
link, vital without an SMTP relay - with a Confirm email action in the
accounts list for accounts already stuck behind it, which now read
"Email unconfirmed" instead of a misleading "Active" (#270). Invite
and open-mode sign-ups still confirm their email the normal way.
Shipped as v2.35.0.

Settings discoverability (2026-06-07): the editor's gear now opens the
settings of what is on screen (story settings when a story is open),
the story-title crumb links there too, and asset-backed features
(cover, edition downloads, avatar upload) hide entirely when no bucket
is configured, replaced by a single admin overview warning (#272).
Sections of the settings pages then became real pages: /admin/users,
/account/security, /stories/<slug>/settings/pagesetup,
/universes/<slug>/categories, with the default section resting on the
bare URL, unknown slugs 404ing, old ?section= admin links redirecting,
and the universe export download moved to /export/download out of the
section page's way (#273). The editor's In this scene list then split
by entity type, and the right rail learned to scroll when a reference
outgrows the pane (#274). Shipped as v2.35.1.

Next-phase batch in flight (built on develop 2026-06-07, not yet
released). Three things from the 2026-06-06 capability-review candidate
pool, plus two decisions:

- Duplicate scene: a row-menu "Duplicate scene" makes a full copy
  (title + "(copy)", body, status, summary, planning fields, and
  markers re-anchored) directly after the source - the building block
  for keeping a scene as a reusable template. duplicateScene in
  scene-split-merge.ts behind /api/stories/[id]/duplicate-scene; a
  "copy" icon added to the set. Integration + e2e cover it.
- Notes: the long-disabled Notes segment is now a real view at story
  and universe scope (migration 0048 adds the notes table with all four
  scope FKs; only universe + story notes are created from the UI,
  scene/chapter attachment reserved). Pinned/recent list, prose editor
  with autosave (/api/notes/[id]), pin/delete, and full History
  (preview + restore) reusing the revision machinery ('note' was
  already in the revisions enum; added the note branch to
  ownedEntityBody/restoreRevision and to both REVISABLE lists). Story
  view peeks universe notes under "From the universe". Cascade cleanup
  wired into deleteStoryWithin and purgeUniverseWithin (so account
  deletion is covered too); notes ride the story, universe, and account
  exports under notebook/ (import round-trip deferred). Help: a Notes
  section added to
  planning.md. Integration (9) + e2e cover CRUD, scoping, restore, and
  cascade.
- SillyTavern/lorebook import removed from the roadmap entirely
  (author's call: no expected use); Phase 9 is now just the LLM work.
- TTRPG positioning decided: keep it in the pitch but scoped to
  campaign prep and worldbuilding (campaign wiki, not VTT/maps/stat
  blocks); close the capability-review gap with docs, not features.
  See the roadmap candidate notes for both.

v2 wind-down, in flight (author away, autonomous; full release flow per
item, best-judgment on forks documented in PRs). Done: self-host
walkthrough (docs/SELF-HOSTING.md) and help docs coverage (account,
security, shortcuts articles) - shipped as v2.37.0; write-path rate
limits (per-user autosave + upload budgets, single-replica stance
documented) - shipped as v2.38.0; writing goals and deadlines
(account daily word goal + per-story target/deadline, surfaced on the
Session tab and Insights; migration 0049) - shipped as v2.39.0. That
clears the autonomous batch.
Held for the author (need a design steer): front/back matter and draft
comparison UI. Then the v2 -> v3 boundary (the held /code-review ultra
run).

GitHub-issue feedback batch (2026-06-08, author filed #285-#288 from
user feedback + design drift; autonomous, full release flow per item).

- [x] #286 bold-then-italic stripping the bold: toggleInlineMark no
      longer reads the inner star of a \*_ as an italic mark (italic only
      unwraps an isolated _); bold/italic compose either order. #285 inline
      create forms dismissable: visible Cancel on the dashboard forms,
      Esc-to-cancel on the add-relationship and universe-plan new-story
      forms. Both merged 2026-06-08 (#289), shipped as v2.39.1.
- [x] #287 (reframed by author): the whole-story view IS the editor and
      editing there is correct; the gap was discoverability (no toolbar read
      as read-only) plus the want for a true preview. Put the formatting
      toolbar into the whole-story view (acting on the focused scene, preview
      toggle in that bar, not the top bar - author's call), and added a
      read-only export preview (view=preview) through the shared
      renderMarkdown so it matches the export (markers gone; alignment, page
      breaks, scene-break text, paragraph style applied), plus a "Preview the
      story" palette command. Merged 2026-06-08 (#291), shipped as v2.40.0.
- [x] #288 entity read-only card in the right column (design-drift
      restoration of the prototype's EntityInspector): clicking an entity in
      the editor's "In this scene" list, or "Open full details" on a mention
      hover, replaces the right column with a read-only card (summary,
      description, typed relationships, details, open-in-plan link); related
      entries open in the same card with a Back stack. Owner-scoped GET
      /api/entities/[id]/card (getEntityCard in plan-data). Scoped to the
      editor right column (in the plan the entity is already open for
      editing). Merged 2026-06-08 (#293), shipped as v2.41.0. Batch complete.

GitHub-issue quick-wins batch (2026-06-08, branch
`fix/quick-wins-feedback`; four cleanly-scoped items pulled from the
open issues, the larger requests #301/#305/#306/#307/#309 deferred to
their own branches). Implemented and tested locally; PR and version on
merge.

- [x] #302 entity-category swatch showed a tall oval when no colour was
      set: the swatch's `class:empty` collided with the app-wide `.empty`
      helper (theme.css padding), stretching the 16px circle. Renamed the
      modifier to `no-colour`; an e2e assertion keeps the swatch square.
- [x] #303 a "Library" breadcrumb before the universe name in TopBar.
- [x] #304 admins could not enable publishing for themselves: added
      `enableOwnPublishing` (account server, admin-gated) with a self-serve
      button on the account public-page block, and unhid the admin-panel
      publishing toggle for admin and own rows. Integration test covers the
      gate.
- [x] #308 Preview button on the single-scene toolbar (`previewHref`
      threaded through SceneEditor), not just the whole-story view.

Editor legibility batch (2026-06-08, branch `feat/editor-legibility`;
the "editor legibility" group from the next-batch triage, author chose
WYSIWYG Enter and remembered toolbar toggles). Implemented and tested
locally; PR and version on merge.

- [x] #307 Enter = paragraph: a custom Enter (`editor-enter.ts`,
      Prec.high) inserts a blank-line paragraph break, Shift+Enter a soft
      newline, and a list/quote line still continues its markup; defers to
      the autocomplete popup when it is open. Applies to the prose
      (non-plain) editors in both editing modes. No auto-migration of
      existing single-newline prose - #306 helps fix it by eye.
- [x] #306 show non-printing characters: a toolbar toggle
      (`editor-nonprinting.ts`) showing spaces via the built-in highlighter
      plus a pilcrow at paragraph breaks and a return-arrow at soft wraps -
      the glyph that tells the two apart.
- [x] New (author request): a toolbar toggle to hide the command markers
      (\center, \right, \justify). `editor-alignment.ts` gained a
      hideMarkers mode that replaces the marker except on the line being
      edited, like rich mode does for `**`/`#`.
- Both toggles are remembered per user (`nonPrintingMarks`,
  `commandMarkers` in UserPreferences; a `POST /api/editor-view` persists
  them from the bar) and also live under Editor behaviour on the account
  page. Shared across every editor in a story via runtime compartments.

Entity badges batch (2026-06-08, branch `feat/entity-badges`; issue
#305, author chose per-entity scope and badges everywhere). Implemented
and tested locally; PR and version on merge.

- [x] #305 per-entity badge colour and image: `badgeColor` +
      `badgeAssetId` on characters/places/lore (migration 0050, additive),
      a `badge` asset kind. Resolution order image -> per-entity colour ->
      category colour -> name hash, in a shared `entity-badge.ts` helper and
      an `EntityBadge.svelte` used across the badge sites (plan sidebar,
      entity card, entity editor, mention hover, autocomplete, story right
      panel). The relationship-web graph and the insights heat tiles keep the
      category colour (graph/stats surfaces, not editing); related mini-dots
      keep the name hash for now.
- The menu lives on the entity editor's large badge: a colour palette (with
  Default to clear) plus, when assets are configured, Upload image; an
  image set offers Remove/Download. Colour PUTs and the image POST/DELETE
  go to `/api/entities/[id]/badge` (server `entity-badge.ts`, mirroring
  the avatar flow). No per-entity asset cleanup needed: entities only go
  on universe purge, which already sweeps assets by universeId.

Page setup: line spacing + binding gutter batch (2026-06-08, branch
`feat/page-setup-spacing-gutter`; the page-setup half of the #309
conversation, plus a print-binding gutter the writer asked for). The
deferred per-user paragraph styles are recorded in
`scratch/system-design/paragraph-styles-309.md`; the gutter feasibility
spike (Chromium honours mirrored `@page :left/:right`, page numbers
coexist) in `scratch/system-design/page-setup-gutters.md`.

- [x] Line spacing: a `lineSpacing` page-setup knob (single / normal /
      relaxed / double) replacing the hardcoded 1.6 across pageCss (PDF),
      the print route, the in-app preview, and the EPUB. Shown in the
      preview, which is now also dimensioned to the page's text-column
      width and print font so line length matches the export.
- [x] Binding gutter: a `gutter` knob (none / narrow / wide) adding inner
      margin on the spine edge, emitted as mirrored `@page :left/:right`
      via a shared `pageRuleCss`. The PDF moved off Chromium's uniform
      margin option to CSS-driven margins (`preferCSSPageSize`), which the
      spike confirmed coexists with the page-number/header layer. Print and
      PDF only; the continuous preview can't show the per-page alternation.
- Controls added to both page-setup forms (story override + account
  default); unit tests cover line-height, mirrored @page, and the
  preview content width; an e2e checks the preview reflects spacing.

Paragraph indent batch (2026-06-08, branch `feat/paragraph-indent`;
the resolved #309 - the writer only wanted Word/OpenOffice-style
increase/decrease indent, named styles dropped).

- [x] Per-paragraph block indent: a `\indent` / `\indentN` marker
      (`indent.ts`) at paragraph start, after any alignment marker, stepped
      0..6 by `setIndentChanges` (`editor-format.ts`) behind two toolbar
      buttons and Ctrl+] / Ctrl+[. `markdown.ts` (`codex_indent`) strips the
      marker and renders it as an inline `margin-left`, so it shows on every
      surface (editor, preview, print, PDF, EPUB) with no per-surface CSS.
- [x] Editor decoration `editor-indent.ts` shifts the lines and dims/hides
      the marker under the existing command-markers toggle (#306);
      `alignmentFor` became `commandMarkerExtensions` (alignment + indent).
      The #309 design note is marked resolved.

Author review mode batch (2026-06-08, branch `feat/author-review-mode`;
#301, plus two toolbar asks the author folded in).

- [x] #301 author self-review: the author opens their own story in review
      mode (`/stories/[id]/review`, linked from the settings Review section)
      and leaves their own comments and suggested edits with the same
      select-to-comment/suggest surface guests use; invited reviewers see the
      author's notes too. reviewSuggestions gained authorUserId (migration
      0051, reviewerId now nullable, mirroring reviewComments); createSuggestion
      and listSuggestions take/resolve the author-or-reviewer author, and
      reply/resolve/accept/reject stay author-only. The author can accept their
      own suggestion to apply it.
- [x] Toolbar overflow menu: the two view toggles moved into a "View options"
      ("...") popover in EditorToolbar, decluttering the main row.
- [x] Command markers inverted to match non-printing: default hidden, click to
      show (UserPreferences default flipped; the editor still reveals a marker
      on the line being edited). Closes the original feedback issues #301-#309.

- [x] 3. Markdown import (capability review, 2026-06-06; collision
     design agreed 2026-06-06). Imports our own story export ZIP into a
     chosen universe, always as a new story, from universe settings
     next to Export. Always two steps: upload, preview (counts plus
     every collision and its resolution), confirm. Collision rules as
     agreed: duplicate story titles allowed (slug auto-suffixes),
     chapters/scenes cannot collide, notes match entities by trimmed
     case-insensitive name + kind (match attaches and joins the story,
     no match creates a minimal entity, ambiguity skips with a flag),
     aliases never match, assets re-upload as new ids, re-import makes
     a sibling story. The exporter writes chapter.md so chapter titles
     round-trip. Out of scope: universe/account archive import, foreign
     markdown, import into existing stories. Merged 2026-06-06 (#178),
     shipped as v2.29.0.
- [x] 4. Export completeness (capability review, 2026-06-06). Story
     notes ride in the story, universe, and account exports as per-story
     notes/ folders; relationships as a relationships.md per universe;
     and the account export carries each story's review threads with
     comments, attribution, and anchored excerpts (author's call:
     review threads yes, revision history no - the current text is
     already exported). Frozen editions stay prose-only. Merged
     2026-06-06 (#174), shipped as v2.28.0.
- [x] 5. Notifications (capability review, 2026-06-06; scope agreed
     2026-06-06). The generic core as agreed: a notifications table
     (kind, payload, read/emailed state), a bell in every topbar with
     an unread badge and dropdown (click marks read and follows the
     link, mark-all-read), and a per-kind preference matrix on the
     account page (in-app and email toggles, both defaulting on).
     Events fan out per the matrix: in-app rows immediately, email
     through batched worker digests (10 min singleton window per
     recipient). Kinds: review activity on your stories, replies to
     your review comments (account reviewers), and new accounts
     awaiting approval (admins; replaces the operator email).
     Transactional email stays outside the matrix. Guest reviewers
     with an email get a reviewer digest with a signed opt-out link
     (/review-email-opt-out); reviewer notifications inform without
     navigating, since review links are stored hash-only and cannot be
     rebuilt into the email or bell. Shipped as v2.30.0.

Review redesign (2026-06-10, branch `feat/review-page-redesign`):
ported the Claude Design "Review mode" onto the editor's three-column
app shell so both the author review (`/stories/[id]/review`) and the
guest link (`/review/[token]`) read like the Write view - left
jump-list, centre read-and-review surface with author-coloured marks
and a margin rail, right thread panel. Reviewers are locked to review
mode (other pills disabled) and see entity mentions as click-to-open
quick cards only, never the full details (guest payload trimmed
server-side). Frontend rebuild only: every server action and the
schema unchanged. Shipped as v3.2.0 (#371, #372).

Review follow-up (2026-06-10, branch
`feat/review-responsive-and-bulk-actions`): the guest page collapses
to a tab bar (Scenes / Manuscript / Notes) under 820px so phone
reviewers get a single column again; "Accept all" applies every
pending edit in a scene at once (acceptAllInScene, owner-only); and an
author or reviewer can retract their own comment or pending suggestion
(deleteComment / deleteSuggestion, scoped to the actor - the opening
comment of a thread only goes when no one else has replied, so a
retraction never destroys others' words; clearing a reviewer's note is
still resolve/reject, not delete). Same branch also took the review
polish backlog: entity mentions in the review prose are keyboard
reachable (tab-focusable, Enter/Space opens the quick card) and the
card clamps to the viewport (flips above near the bottom edge); the
Write load now shares `reviewMentionData` instead of duplicating the
entity query (lore mentions gain their badge fields as a side
consistency fix); and the help doc covers clickable names. No schema
change. Integration + e2e (incl. a new review quick-card spec) + help
docs updated.

Review-build match + editable centre (2026-06-10, branch
`feat/review-build-match`): v3.2.0 was built from the standalone
`review.jsx` mock, not `review-build.html` (the full app booted into
review mode), so the shipped cards and panel drifted from the current
design. Reconciled the cards and panel to the build (header-corner
quick actions: open comment -> resolve, open suggestion -> accept +
reject; type pill only on decided/resolved cards; `.rv-quote` accent
quote; composer takes over the panel). Then made the author's review
centre the real editor: the manuscript is now editable in place
(CodeMirror), with comment highlights and tracked suggestions drawn as
decorations over the live text (inserts/replacements ride as
non-editable ghost widgets) - accept a suggestion, then keep building
on it. Guests stay on the read-only surface. The scene autosave omits
markers, and the scene PUT endpoint leaves stored marker anchors
untouched when the field is absent (so a review save never wipes a
scene's TODO markers). New `ReviewEditor.svelte` + `editor-review-marks`
StateField layer; `buildReviewMarks` unit-tested; review e2e updated for
the editor-based centre plus accept-then-edit-persists. No schema
change. Released as v3.3.0.

Review polish follow-up (2026-06-10, post-v3.3.0): four fixes from
testing v3.3.0. (1) The review left rail is now the Write outline tree
(chapters and scenes, read-only) with a per-scene review count in place
of the word count and a running total at the top, matching
`review-build.html`, instead of the flat jump-list it had shipped as;
the filter pills moved off the left (they live on the notes panel).
(2) The four-mode seg (Write/Plan/Notes/Review) no longer overflows the
rail (`.seg.full .seg-btn` shrinks and trims its padding). (3) Clicking
a whole-scene comment now scrolls to the top of the scene (it has no
anchor) in both the author editor and the guest surface. (4) The review
editor reuses the shared `EditorToolbar` (so it gains alignment, indent,
and the non-printing/command-marker view toggles); that toolbar is now
responsive - tools that do not fit collapse into a "More tools" overflow
menu that disappears entirely when everything fits. Author review load
now reads `storyPreferences` for the toggles. e2e: a `toolbar.ts` helper
reaches a tool inline-or-in-menu; split/indent/align/legibility specs
use it. No schema change.

Review polish follow-up 2 (2026-06-10, post-v3.3.1): six smaller fixes
from a second pass. (1) Outline scene/chapter names left-aligned (they
are buttons now, whose UA default is centred) and (2) their hover/active
background restored (the button reset was beating the shared rule by
source order). (3) Air below a comment body so the replies and reply box
do not crowd the text (`.rv-body` margin). (4) Accepting or resolving the
last open note in a scene no longer yanks the centre to the next active
scene: the shown scene is pinned once chosen, so the author stays on the
change to keep editing (root cause: `selectedSceneId` fell back to the
re-deciding `firstActive` while `chosenSceneId` was null). (5) Clicking a
resolved/decided note under the Done filter now shows a faint neutral
outline where it sat (new `rv-resolved` mark in `buildReviewMarks`, drawn
only under that filter, no strikethrough or before-text). (6) The notes
panel filter pills renamed: All -> Open, Resolved -> Done. Unit + e2e
coverage added for the scene-pin and the resolved marks. No schema change.

Assistant feedback batch (2026-06-10, branch `claude/dreamy-edison-faa9dp`;
first real use of the Assistant. Author decisions taken up front:
automatic review replies, discussion threads on suggestions, and all
three ride-along extras). Nine commits, each shippable:

- [x] Outline scene ids: the model could not read scenes beyond the open
      one (the rendered story outline carried no ids for get_scene - the
      author's "chapter two" test). Ids now ride the outline and
      nearby-scene lines, the system message mentions the scene tools on
      tool-capable turns only, and a list_scenes read tool covers the
      budget-dropped case.
- [x] Composer menu: "Catch me up" and "Update summaries" moved from the
      Assistant tab header into a menu next to the send button; the mute
      link keeps the header. "Clear conversation" joined later.
- [x] Assistant submenus: the sidebar row menu and the editor selection
      menu group assistant actions under an Assistant flyout (the lore
      category pattern). The selection menu gains "Ask the Assistant about
      this": the passage rides to the chat composer as a removable
      reference chip via a small intent bus (assistant.svelte.ts), carried
      as data on the user turn and folded into the model-bound message
      server-side (prompts/reference.ts).
- [x] Coauthor reference: the Write panel captures the selection or the
      text before the cursor as a removable chip and sends it with the
      brief, so "continue from here" lands in the right place.
- [x] Scene-split proposals: a propose_scene_split write tool stages a
      proposal (exact start text + rationale, validated by a shared pure
      locator) that the gateway forwards as a new `proposal` SSE frame;
      the chat panel renders a card with "Split here", and confirming
      re-locates the text server-side at that moment before the existing
      splitScene path. The scene row submenu gains "Suggest where to
      split" (a canned chat turn). Nothing changes without the confirm.
- [x] Review replies: suggestions gained a lazily created discussion
      thread (migration 0059, unique nullable suggestion_id on
      review_threads); pending suggestion cards take replies on both
      review pages, with reviewer notifications deduplicated across the
      suggestion author and thread commenters. Replying in a thread the
      Assistant opened triggers its answer automatically:
      POST /api/assistant/review-reply (owner-only, assistant-rooted
      threads only) runs a reviewer turn with scoped tools
      (reply_in_thread, update_suggestion) whose targets are fixed
      server-side; update_suggestion only revises the Assistant's own
      pending replacement, and prose without a tool call is staged as the
      reply. Guests can never trigger it. Delete-order fixes rode along
      (threads before suggestions in the cascades; retracting a
      suggestion takes only its own discussion).
- [x] Insert at cursor: completed chat replies offer "Insert at cursor"
      while a single scene editor is open.
- [x] Palette commands: Ask the Assistant, Catch me up, Update summaries,
      and Review this scene on the write page, gated like the other
      surfaces; the scene-review and summaries fetches moved to a shared
      assistant-actions client helper.
- [x] Persisted chat: assistant_chat_messages (migration 0060), one
      conversation per story per user; turns persist as they complete
      (references and proposals in meta), the page seeds the panel, Clear
      conversation deletes, conversations cap at a recent window, and the
      rows ride the story delete and account purge.

Lint, check, and the full unit + integration suite (890) pass locally
against Postgres; the account, selection-menu, review, and split e2e
specs pass against a substitute Chromium (the author-review spec is
flaky under it - drag selection corrupts text even at the base commit
there - so CI's real browser gates it). Live-model verification of the
new prompts is left for the author's endpoint.

Review accept race (2026-06-10, post-v3.4.0): chasing the author-review
spec flake exposed a real data-loss window, not just a test problem.
The review editor only learned of an accepted suggestion when the page
data reloaded, and its local-edits-win sync meant any autosave carrying
unsaved or in-flight typing in that window silently reverted the
accepted text. Fixed by folding the accepted change into the live
document the moment the server confirms it: decide/accept-all report
the applied ids, the cards and panel hand them to the editor before the
data refresh, and the editor applies each replacement at its live
anchor (the marks field maps anchors through typing; anchorOf now also
resolves insert ghosts) while dropping the decided marks in the same
transaction. The spec deflake (#390) and a new e2e that accepts and
types with no settling wait both ride the same branch history.

Split proposal follow-ups (2026-06-10, post-v3.4.0, from first real use):
(1) When the model proposed several splits of one scene, only the first
confirmed: the later passages had moved into the scene that split
created. locateSplitInStory follows the passage to whichever live scene
of the story holds it now (unique across scenes, then unique within);
the split endpoint re-targets through it. (2) The model passed the text
the first scene should end with, cutting before it: the tool parameter
renamed to newSceneStart with a worked example in the description (the
old name still lands for cached schemas), and the canned sidebar turn
asks for the new scene's opening words. (3) Seam whitespace was already
shed on both sides by splitScene; pinned with a test. (4) Proposal
cards now show a confirmed split as done with a Revert that merges the
two scenes back (merge-scenes), the decided state persisted on the
stored chat turn (confirmed on the meta proposal entry, no migration)
so it survives reloads.

## Phase 1 - Foundations

- [x] 1. Scaffold SvelteKit + TypeScript on adapter-node, with test harness
- [x] 2. Drizzle + node-postgres, users table, first migration
- [x] 3. Dockerfile, compose.yaml (app, worker stub, postgres, Caddy), compose.dev.yaml
- [x] 4. Run the stack in Docker end to end
- [x] 5. Sign-in: sessions, auth_tokens, password check, server hook guard
- [x] 6. Seed admin via SQL; verify sign-in and the approval gate

> v0.1 shipped at the end of Phase 1.

## Phase 2 - Core content

- [x] 7. universes, stories tables; CRUD pages
- [x] 8. Shell layout port from prototype (top bar, three columns, CSS tokens)
- [x] 9. Focus mode
- [x] 10. chapters, scenes; scene tree in left sidebar
- [x] 11. CodeMirror 6 editor, debounced autosave, Compartment wrapping
- [x] 12. Drag-to-reorder scenes
- [x] 12b. Continuous story view, read-only (pulled forward from Phase 6)

> v0.5 shipped at the end of Phase 2 (plus v0.2 along the way).

## Phase 3 - Worldbuilding

- [x] 13. Characters: schema, Plan view CRUD, story notes overlay, aliases
- [x] 14. Entity mentions index, worker rebuild, editor underlines, hover tooltips
- [x] 15. Find usages / appears-in panels
- [x] 16a. Places (v1.1): schema, Plan view, story notes, mention pipeline
- [x] 16b. Lore entries and entity categories (v1.2), incl. entity-colour groupings
- [x] 17. Universe editor (v1.3): universe-scoped Plan view, no "In this book" without a story, dashboard lists stories per universe and routes the universe name to the editor (Notes view still does not exist at any scope; it stays a disabled toggle)
- [x] 18. Entity relationships (v1.4): relation_types + entity_relationships schema (story_id and custom types modelled, no UI yet), 15 built-ins seeded by migration, editor section with typed picker + target select + notes, right-panel card, inverse labels on the target's page
- [x] 19. Outline tree (v1.5): outline_nodes schema, Outline group atop the story Plan sidebar (drag reorders siblings, buttons indent/outdent), node editor with notes and scene/chapter link, delete promotes children (placement and nesting interaction confirmed with the author; no designed screen existed)
- [x] 20. Declared story membership: membership tables, story Plan lists members-or-mentioned, create-in-story declares, "From the universe..." select adds existing entities, editor shows the standing with add/remove (ships with v1.6)
- [x] 21. Entity autocomplete (v1.6): completion source over names and aliases, popup and ghost-text modes in the reserved compartment, user preference (popup default) stored in users.preferences; the three-option select sits on the dashboard until Display settings arrives at step 32

> Phase 3 complete: v1.0 shipped after step 15 (gated on the full code
> review; findings fixed, leftovers in the backlog below), then v1.1
> through v1.6 in turn. Next is Phase 4 (history, polish, import/export),
> steps 22-27, releasing as v2.0. The author holds 3 free /code-review
> ultra runs, intended for phase boundaries.

## Phase 4 - History, polish, import/export

- [x] 22. Revisions and history (v1.7): polymorphic revisions table, insert on body-changing saves across all five types, checkpoints with labels, Reference/History tabs in the right column, preview banner with jsdiff changes toggle, restore-on-top, story and universe settings timelines
- [x] 23. TODO markers (v1.9): scene_markers schema, TODO: line detection shared by editor and panel, selection markers via Ctrl+Alt+M with anchors mapped through edits and persisted on autosave, To do card in the Reference tab with check-off
- [x] 23b. Editable continuous view (v1.10): the story view stitches one SceneEditor per scene (own autosave chain, mentions, autocomplete, markers), vertical arrows cross scene boundaries, and the continuousSceneMarks preference hides the scene marks for authors who treat scenes as atomic splits (both first-use feedback items)
- [x] 24. Scheduled off-site backups and restore (v1.8, cadence in v1.8.1): hourly pg_dump from the worker to any S3-compatible bucket with skip-if-unchanged and tiered retention (48h full, 30d daily), admin "Back up now" with visible run history, restore script drilled live against MinIO (took the slot SillyTavern vacated; pulled forward from step 33 because no disaster recovery means not production ready). WAL/PITR noted as a Phase 6 candidate.
- [x] 25. Assets and images (v1.11): S3-compatible storage as the only backend (author's call: a database restore keeps every asset link valid), separate bucket from backups, off until ASSET*S3*\* set with an optional minio compose profile, paste/drop image upload in the scene editors inserting markdown, story covers with a generated SVG default, app-served with nosniff
- [x] 26. Markdown, EPUB, and PDF export (v1.12): shared markdown-it renderer (raw HTML escaped), zip of front-mattered scene files with bundled rewritten assets, hand-rolled minimal EPUB3 over fflate (stale libs declined), print-optimised route for PDF via the browser dialog; Export section in story settings
- [x] 27. Public reading pages, self-host (v2.0 candidate): publications table, publish freezes editions (gated on admin-enabled archive + claimed handle), /@handle shelf and per-story reader (semantic HTML, adult confirmation + noindex, public covers), visibility private/unlisted/public, admin enable + takedown. RSS noted as easy follow-on.

> Step 24 was originally SillyTavern/lorebook import, dropped on 2026-06-04
> at the author's call; that now sits in the roadmap's Phase 6 candidates,
> and the schema already models for its return (imported_from,
> activation_mode). Step 25 resolved the asset-durability question by going S3-only.

> Phase 4 complete; shipped as v2.0. The /code-review ultra run before the
> tag found 10 issues (9 public-surface + 1 pre-existing story-delete
> cascade); all fixed and merged. Phase 6 candidates recorded along the
> way: stored export artifacts (GitHub-releases style) and SillyTavern
> import. Next is Phase 5 (account lifecycle and hosted launch), steps
> 28-35, releasing as v2.5.

## Phase 5 - Account lifecycle and hosted launch

Make the app safe to point strangers at. Releases as v2.5. Sequencing
agreed with the author on 2026-06-04: TOTP promoted forward from Phase 6
(step 32b); in-app /docs held to the end of the phase; the default editing
format preference deferred to Phase 6 (see the feedback backlog).

- [x] 27b. Harden the admin bootstrap CLI (v2.0.1). The seed:admin script already exists and runs in-container (docker compose exec app node scripts/seed-admin.ts <email> <password> <name>), creating a pre-verified pre-approved admin. Make it a true first-admin-only bootstrap: refuse with a clear message if any admin already exists (after that, admins are managed in-app), catch the duplicate-email case instead of dumping a stack trace, and read the password from a prompt or stdin rather than argv so it stays out of shell history. Document the one command for operators in the README. A prerequisite for the rest of Phase 5: there is no admin to approve sign-ups without it.
- [x] 28. Sign-up page (v2.1): /signup creates an unverified, unapproved user, issues an email_verify token, and enqueues the link; the page shows a neutral "check your email" even for a taken address (no enumeration). Login link added.
- [x] 29. Email verification flow (v2.1): /verify-email consumes the single-use token and sets email_verified_at; both gates already enforced by verifyCredentials. Pluggable email abstraction ($lib/server/email) sent from the worker via a send-email job, with a console transport by default and SMTP (nodemailer, SMTP_URL) for production.
- [x] 30. Password reset flow (v2.2): /forgot-password issues a 1h password_reset token and emails the link (neutral message, no enumeration); /reset-password consumes it, sets the new password, and revokes existing sessions. Length checked before the token is spent so a bad attempt does not burn the link.
- [x] 31. Admin approval UI (v2.3): /admin lists pending accounts (name, email, sign-up time, email-confirmed state) with approve/reject, admin-gated (404 to non-admins); approve sets approved_at, reject deletes the brand-new row and its tokens. Operator(s) emailed on each new sign-up.
- [x] 31c. SMTP relay configuration (v2.4.2): an Email relay section in the admin panel sets host/port/TLS/user/password/from and sends a test email. Effective config is the database row if set, else the SMTP\_\* environment seed (compose passes them through). The password is encrypted at rest (AES-256-GCM via a new crypto helper keyed from APP_SECRET, reusable later for LLM keys and TOTP); a blank password on save keeps the stored one. Settings live in a new app_settings key-value table (migration 0019). The worker sends via the effective config, falling back to the worker log when nothing is configured.
- [x] 31b. Site admin panel (v2.4.1): /admin is now a proper panel with all site administration gathered off the dashboard - Accounts (full list: approve/reject, enable/disable each user's publishing, suspend/unsuspend), Published editions (list + takedown), Backups (config, history, run now). Suspension adds a suspended_at column (migration 0018) and is enforced in verifyCredentials and validateSession (a live session drops on the next request). The dashboard is now purely the user's library. Admin-initiated account deletion is deferred to 32-danger (shared cascade).
- [x] 32. Account self-service. Shipped across releases:
  - [x] 32a (v2.4): /account page - change display name, change password (verifies current, revokes other sessions), review active sessions with revoke-one and sign-out-everywhere-else. Linked from the dashboard.
  - [x] 32-email (v2.4.5): change email with re-verification. /account takes a new address + password; the live email only swaps on confirming the link sent to the new address (/confirm-email-change), so a typo never locks anyone out. Additive pending_email column (migration 0021), email_change token kind.
  - [x] 32-danger. Danger zone, two parts (build export first - it is the "export first" safety net and is read-only):
    - [x] Export-everything (v2.4.3): /account/export downloads one zip of every universe (description), character/place/lore entry (front matter + summary + body), and full story (chapters/scenes), with referenced images and covers bundled and links rewritten. Reuses the step 26 exporter pieces. Story-scoped note overlays not yet included (noted).
    - [x] Delete-account (v2.4.4, GDPR with a 7-day regret period): self-service delete on /account re-confirms the password, then deactivates the account (suspended + sessions dropped) and takes down all public editions at once, sets deletion_scheduled_at +7d, and emails a cancellation link (/cancel-deletion) that reactivates if clicked in time. A worker job (hourly) purges accounts past the window: full hard cascade (shared deleteStoryWithin per story, then universe entities/categories/relationships, assets + S3 objects, sessions/tokens/user). Admin delete on /admin runs the same cascade immediately (never an admin or self). Migration 0020 adds deletion_scheduled_at; deletion_cancel token kind added. Editions stay down on cancel (republish to restore) - noted.
  - Note: handle claim and preferences already live on the dashboard; fold them into /account when the page is consolidated.
- [x] Design adaptation (author's design in scratch/app-design/new_admin/, handed over 2026-06-04). Redesign /admin and /account onto the new sidebar-shell design system; full scope agreed (avatar, pen name + social links, theme + accent colour, stubbed deferred sections). Build in slices, each its own release toward v2.5:
  - [x] D1. Design-system port: brought admin.css and pages.css into src/lib/styles (loaded globally after theme.css). Reconciled with the editor system: added the missing --radius-md token; scoped theme.css's unused entity-detail .field under .fields so the bare .field is free for forms; scoped the page-shell .topbar/.brand under .page-shell so the editor top bar is untouched; reused the editor's existing .seg/.toggle rather than duplicating them (kept the new .toggle-row, .toggle-xl). No visible surface yet (D2-D5 consume these); lint, check, unit tests, and build pass.
  - [x] D2. /admin rebuilt on the new sidebar shell. Overview (stat cards from instanceStats + a real "needs attention" list + health footer), Users & access (pending approvals + accounts table with role tags and row actions: approve/decline/publishing/suspend/delete, guarding admins and self), Published (editions + take-down, kept from the old page as its own nav item), Backups (configured state, run-now, run history), Email relay (SMTP form). AI / Usage / Audit are visible "soon" stubs. instanceStats() added to admin.ts with integration tests; all existing actions and the non-admin 404 gate unchanged.
  - [x] D3. /account rebuilt on the sectioned shell (Profile / Security / Display). Profile: display name + public-page block (claim handle write-once, bio, profile-public toggle), gated on publishing being enabled. Security: change email, change password, two-factor placeholder (32b), sessions, export, delete. Display: editor preferences (autocomplete, scene marks). Folded the handle claim and preferences in from the dashboard (now just the library + a pointer to /account); added saveProfile() and claimHandle() to account.ts with integration tests; surfaced handle/bio/profile-public. e2e account + core-flow specs updated and green. Theme/accent -> D5; pen name/social/avatar -> D4.
  - [x] D4. Profile new fields. Migration 0022 adds users.pen_name, links (jsonb {label,url}[]), commissions_open, commissions_md, avatar_asset_id (additive). saveIdentity (display name + pen name) replaces changeDisplayName; saveProfile extended with links/commissions; parseLinks (pure, unit-tested) normalises and caps the links array. Avatar reuses the S3 asset store: 'avatar' asset kind, setUserAvatar/clearUserAvatar (replace drops the old image), upload/remove actions on the account Profile section (gated on assets being configured, initials fallback). Public surfacing: publicProfile + isPublicAvatar in publish.ts, an author header (avatar, name/pen name, bio, links as http(s)-only anchors, commissions) on /@handle when the profile is public, and the avatar served publicly only while it is the current avatar of a public profile. Integration tests for saveIdentity/saveProfile, avatars, publicProfile/isPublicAvatar; e2e account spec updated (pen name + "Save changes"). Lint, check, unit/integration (204), build, and the account + core-flow e2e specs pass.
  - [x] D5. Theme + accent colour. Shared pure $lib/appearance.ts (Theme union, accent presets, isTheme/isAccentColor/normaliseAccent); userPreferences extended with theme ('system'|'light'|'dark', default system) and accent (hex, default #5b8cff), validated on read. Account Display gains an Appearance block (theme select + accent swatches + custom colour picker) with a live preview and a saveAppearance action. Applied app-wide via the existing data-theme attribute and a documentElement --accent override: $lib/appearance-apply.ts sets both and syncs the codex-theme/codex-accent localStorage keys the app.html pre-paint script reads (extended to apply the accent), and a new +layout.server.ts feeds the signed-in user's saved appearance into the root layout so a fresh device adopts it. Unit tests for the validators, integration tests for the preference defaults/round-trip/fallback, e2e covers selecting and applying a theme. Lint, check, unit/integration (211), build, and the account + core-flow e2e specs pass.
- [x] 32b. TOTP two-factor, in the /account Security section. TOTP itself (RFC 6238) is implemented on Node crypto in a pure totp.ts (base32, generate/verify with a 1-step drift window, otpauth URI, recovery code gen/hash); only qrcode is added as a dependency, for the QR. two-factor.ts orchestrates enrolment, verification, recovery codes, and a signed short-lived sign-in challenge; the secret is encrypted via crypto.ts (new HMAC signToken/verifyToken there back the challenge). Migration 0023 adds user_totp + totp_recovery_codes (additive); purgeAccount clears them. Account Security shows the real flow: Set up -> scan the QR or enter the key -> confirm a code -> recovery codes shown once; On state offers regenerate and turn-off. Sign-in branches after the password: with 2FA on, the login sets a challenge cookie and redirects to /login/totp (public path), which accepts a code or a recovery code and only then creates the session. Admin Users gains Reset 2FA for lockout recovery (surfaced via a twoFactorEnabled flag). Unit tests (RFC vectors, recovery codes), integration tests (enrol/verify/recovery/disable, challenge sign/verify), and an e2e enrolment journey. Lint, check, unit/integration (225), build, and the e2e suite pass. Passkeys stay in Phase 6.
- [x] 33. Operational essentials + cross-user isolation audit. Rate limiting: a small in-memory fixed-window limiter (rate-limit.ts, unit-tested) keyed by the targeted account (no trusted client IP behind the proxy), applied to login (per email), sign-up and password reset (per email, returning the same enumeration-safe response without mailing on the limit), and the two-factor challenge (per user, so the six-digit space cannot be brute forced). Structured logs: log.ts emits one JSON event per line; wired into auth events, rate-limit rejections, and a handleError hook for server faults. Health check: GET /healthz (public path) runs a select 1 and returns 200 ok or 503, for the proxy/orchestrator. Isolation audit: reviewed every owner-scoped route, action, endpoint, and data-access helper; found no gaps. Private content is gated consistently through ownedStory/ownedUniverse (owner_id) and transitive joins (scene/outline/marker -> story.owner_id; character/place/lore -> owner_id), with the autosave PUT and asset serving spot-verified; the property is already covered by stranger-denial assertions across ~15 integration test suites, so no new tests or fixes were needed. Public-by-design surfaces (the /@handle reader, public asset/avatar serving, auth pages) expose only published/public data. Lint, check, unit (229), build, and the affected e2e specs (incl. a new /healthz smoke check) pass.
- [x] 34 + 35. Dropped (2026-06-04): the hosted service is one shared instance (GitHub model), not a per-user fleet, so there is no control plane to provision and no central cross-instance reader/handle registry. Deploying the hosted service is just running the image; cross-user isolation is enforced by owner_id scoping and audited in step 33. See the design-doc update.
- [x] In-app help (/docs). Help articles are committed markdown under
      src/lib/docs/ (getting-started, editor, planning, publishing), bundled via
      import.meta.glob and rendered through the existing renderMarkdown; a small
      registry (docs.ts) sets order and index summaries while titles come from
      each file's heading. Routes /docs (index) and /docs/[topic] (404s unknown
      topics). A reusable "?" HelpLink component opens the relevant topic, placed
      on the editor (story sidebar), the Plan view (shared PlanSidebar), and
      publish (story settings); the library page links to the help index. No
      admin help (the admin panel does not need articles, per the author). Tone
      follows the CLAUDE.md writing rules. CLAUDE.md now reminds us to keep the
      docs in step when functionality changes. Unit test covers the registry and
      article lookup; e2e browses the index and opens an article. Lint, check,
      unit (232), build, and e2e pass.

> Phase 5 complete; shipped as v2.5.0 (2026-06-04). The held v2.5 review
> (ultrareview) found six issues - single-use TOTP/replay, password re-auth on
> 2FA disable/regenerate, one-shot enrolment confirm, an avatar-upload race, a
> reverting theme toggle, and a duplicate-link crash on /@handle - all fixed
> before the tag (migration 0024 adds user_totp.last_used_step). Post-v2.5 the
> roadmap's candidate pool was regrouped into themed phases 6-10 + future
> (2026-06-04); the entity quick details (jsonb) + full-fidelity history pair
> landed in Phase 7. One free /code-review ultra run remains.

## Phase 6 - Backend and access

Candidate pool, soft order (see the roadmap for detail). Started 2026-06-05.

- [x] Invite codes: invite_codes table (migration 0026), admin mints codes in Users & access (label, uses, expiry, copy-link), sign-up takes an optional code (or ?code= link) and a valid one sets approved_at immediately; email verification still applies. Redeem is a single guarded UPDATE; register-with-invite runs in one transaction so a duplicate email rolls the use back. Merged 2026-06-05 (#107).
- [x] Stored export artifacts: export_artifacts table (migration 0027), the worker generates markdown zip, EPUB, and PDF from the frozen edition on publish (export-artifacts queue) and keeps them in the asset bucket; PDF renders the shared print HTML through headless Chromium (puppeteer-core + chromium in the image). Settings shows the files with "Generate again" and a per-edition reader-downloads toggle (downloads_public); readers get EPUB/PDF on the public page, the markdown zip stays owner-only. Merged 2026-06-05 (#109).
- [x] Passkeys: webauthn_credentials as designed (migration 0028), crypto via @simplewebauthn/server, named credentials managed in account Security (add via browser ceremony, removal re-confirms the password), usernameless "Use a passkey instead" sign-in with the same account gates and rate limiting as the password path, skipping TOTP (a verified passkey is possession + local check). Challenges in signed purpose-bound cookies; needs APP_SECRET like 2FA. E2e runs the real ceremony against Chromium's virtual authenticator. Merged 2026-06-05 (#111).
- [x] Guest review (comments, then suggested edits)
  - [x] Stage 1 - invitations and threaded comments: review_invitations/reviewers/review_threads/review_comments (migration 0029), magic links with hashed tokens, guest identity via signed cookie (display name only, no account), read-only manuscript at /review/[token] with selection-anchored and whole-scene comments, diff-based re-anchoring (review-anchor.ts; lost anchors degrade to flagged whole-scene), author feedback page at /stories/[id]/review with reply/resolve/reopen, invitations managed in story settings, revoke keeps threads (deliberate deviation from the design line), purge anonymizes a deleted user's reviewer rows. Merged 2026-06-05.
  - [x] Stage 2 - suggested edits: review_suggestions (migration 0030), guests with a can_suggest link propose replacements on exact selections (insertions and deletions included), the author accepts or rejects one at a time on the feedback page; accept re-anchors against the current text (reanchorPoint for insertions), applies to body_md in a status-guarded transaction, records a 'suggestion' revision, and enqueues a mention rebuild; a rewritten passage can only be rejected. Merged 2026-06-05, shipped as v2.9.0.
        Continuous backup (WAL/PITR) is parked by design, only if hourly dumps
        ever bite; the cheap first step is tightening the dump cadence (see the
        roadmap note).

> Phase 6 complete (2026-06-05), shipped as v2.6.0 (invite codes + stored
> exports), v2.7.0 (passkeys), v2.8.0 (review comments), and v2.9.0 (suggested
> edits). WAL/PITR stays parked per the roadmap's own criterion. Next up when
> work resumes: Phase 7 (writing and planning).

## Phase 7 - Writing and planning

Agreed sequence (2026-06-05): the quick details + entity history pair first, then preference layering (prerequisite for the rich-editing choice and page setup), with the self-contained items (spell-check, settings styling, command palette, markdown affordances, mention disambiguation) slotting in between. Started 2026-06-05.

- [x] Entity quick details + full-fidelity entity history: details jsonb on characters/places/lore (migration 0031) edited as the design's Details grid and shown in the hover tooltip (first three), plus snapshot jsonb on revisions capturing name, aliases/keywords, summary, category, details, and the relationship set, so every change registers in History (relationship changes land on both linked timelines) and Restore returns the whole entity, skipping parts whose category/type/target was deleted since; pre-snapshot rows restore body-only. Details ride the account export front matter. Merged 2026-06-05 (#117).
- [x] Preference layering: stories.preferences jsonb (migration 0032), storyPreferences merges the user's preferences with per-story overrides at load time. Only the editor-behaviour keys (entityAutocomplete, continuousSceneMarks) are overridable; theme and accent stay account-wide. Story settings gains an Editor section where "Use my account setting" clears the override (jsonb key delete), so later account changes flow through. Merged 2026-06-05 (#121).
- [x] Rich editing mode + markdown affordances: markdown styles in place in every prose editor (HighlightStyle: bold bold, headings big, marks faint), formatting toolbar on the scene editor (H1-H3, bold, italic, quote, list; Ctrl+B/I everywhere) per the prototype, and an editingMode preference (markdown | rich, user-level with the per-story override) where rich is CodeMirror live-preview: syntax marks hide except on the lines being edited, fully formatted when unfocused, document stays markdown. Continuous-view editors follow the mode but carry no toolbar. Merged 2026-06-05 (#122).
- [x] Page setup for print/PDF: page_setup jsonb on users (account defaults) and stories (per-key overrides; migration 0033), parameterizing the one stylesheet behind the print route and the worker PDF. Page size incl. trims (5x8, 5.5x8.5, 6x9), margins, font + size, paragraph style, scene-break text, and PDF-only page numbers / running title via Chromium's header-footer layer (geometry rides the pdf options). A \page paragraph forces a break in print/PDF and is inert elsewhere. EPUB stays reflowable; paragraph style, scene-break text, and \page carry over. Account page gains a Page setup block, story settings a Page setup section with use-account-setting inherit per field (scene break gets a mode select since blank is itself a value). Verified against real Chromium (5x8 MediaBox, header/footer, mid-scene break). Merged 2026-06-05 (#124).
- [x] Spell-check: browser-native squiggles behind a spellCheck preference (default on) with a writingLanguage tag driving the dictionary; account-level with per-story overrides, an explicit follow-the-browser override distinct from inherit. Merged 2026-06-05 (#126).
- [x] Library and story-settings styling: the library becomes a designed page (topbar, universe cards, avatar menu); story settings adopts the admin-shell with anchor-nav sections (not tabs, so flows and deep links keep working). Merged 2026-06-05 (#128).
- [x] Command palette (Ctrl+K): owner-scoped fuzzy search over universes/stories/scenes/entities (aliases and keywords included) plus contextual commands (new scene/chapter, write/plan/settings/review, library/account/help), with a Search trigger in the top bars. Merged 2026-06-05 (#129).
- [x] Mention disambiguation: deterministic attribution for shared names (pin > story members > character > place > lore > primary name) with per-story pins picked from the hover tooltip (mention_pins, migration 0034); editor underlines and the worker index share the rules. Merged 2026-06-05 (#130).
- [x] Perf debts ride-along: tooltip reads the decoration set; applySceneOrder and updateMarkerAnchors are single batched UPDATEs. Merged 2026-06-05 (#127).

> Phase 7 complete (2026-06-05), shipped as v2.10.0 (quick details + entity
> history), v2.11.0 (preference layering + rich editing), v2.12.0 (page
> setup), and v2.13.0 (spell-check, library and settings styling, command
> palette, mention disambiguation, perf debts). Next up when work resumes:
> Phase 8 (overviews and visualization).

## Phase 8 - Overviews and visualization

Scope agreed 2026-06-05: the four data-ready items, releasing as v2.14.0
(heatmap + dashboard), v2.15.0 (scene board), v2.16.0 (relationship web).
The timeline waits for the world-calendar design and plotlines/arcs wait
for usage evidence, per the roadmap's own criteria. Started 2026-06-05.

- [x] Universe Insights view: a new view at universe scope (sidebar seg next
      to Plan, palette command) on the admin-shell, hosting the entity
      heatmap (mention counts per entity from the existing index, cold tiles
      and no-entry flags for the forgotten corners) and the progress
      dashboard (word totals, net words per day from scene revisions with
      timezone-correct day buckets, streaks, per-story status bars).
      Everything derived at read time; no new tables. Merged 2026-06-05
      (#132), shipped as v2.14.0.
- [x] Scene cards board: the story Plan's centre shows the scenes as
      cards in status lanes (outline/draft/revised/final) when nothing else
      is open; dragging a card (or its hover arrows, the keyboard path)
      changes scene status through an owner-guarded PATCH, the first UI for
      that column. Cards carry chapter, word count, and open-TODO count.
      Merged 2026-06-05 (#134), shipped as v2.15.0.
- [x] Relationship web view: force-directed graph of entity_relationships
      (d3-force simulation run synchronously to rest, own SVG rendering),
      category filter chips and a focus-on-entity select, hover labels,
      click-through to the plan; joins the Insights view. Merged 2026-06-05
      (#136), shipped as v2.16.0.
- [x] Editor selection menu (author request, 2026-06-05): select a phrase
      and right-click for quick formatting (bold/italic/quote/list) plus
      create-a-character/place/lore-entry named after the selection, in
      place with no navigation; mention underlines reconfigure at once and
      a right-click without a selection keeps the browser's own menu.
      Merged 2026-06-05 (#137), shipped as v2.16.0.

- [x] Public face (author request, 2026-06-05): a landing page at / for
      signed-out visitors (ported from the prototype's landing.html; the
      landing CSS was already in the D1 port) and every auth screen
      (login + TOTP step, signup, forgot/reset password, verify-email,
      confirm-email-change, cancel-deletion) restyled onto the design
      system via a shared AuthShell card; labels and actions unchanged so
      the auth e2e flows held. Shipped as v2.17.0.

- [x] Universe settings restyle + URL slugs (author requests, 2026-06-05):
      /universes/[id] joins the admin-shell (the last bare page), and
      universes + stories get per-account slugs (migration 0035, backfilled)
      so URLs read /universes/ardenfall; generated from the name at
      creation, fixed until edited in settings, ids resolve forever. All
      nav surfaces emit slugs; fixed three stale local copies of ownedStory
      the slug work surfaced. Shipped as v2.18.0 (#141, #142).

- [x] Slug edge fixes from the v2.18.0 self-review (2026-06-06): plan
      create-entity actions redirect back to the slug URL instead of the
      id; uniqueSlug suffixes a uuid-shaped base so the slug stays
      routable; create/rename slug races caught (unique violation returns
      the taken message or retries the suffix instead of a 500); slug
      validation shared between the two settings actions (slugChangeError);
      id-or-slug resolver coverage in the integration suite; palette refs
      renamed and the form status styles promoted to pages.css. The 0035
      backfill's lack of accent folding stays as-is (slugs are valid and
      editable; rewriting shipped rows would break links). Merged
      2026-06-06 (#144), shipped as v2.18.1.

> Phase 8 complete (2026-06-05), shipped as v2.14.0 (Insights: heatmap +
> progress dashboard), v2.15.0 (scene cards board), and v2.16.0
> (relationship web + editor selection menu). The timeline view stays
> parked on the world-calendar design, and plotlines/arcs on usage
> evidence, per the roadmap's own criteria. Next up when work resumes:
> Phase 9 (AI and interop) - or the timeline's calendar design talk,
> whichever the author wants first.

## Phase 9 - The Assistant (LLM)

Full design in `scratch/system-design/assistant.md`. Building foundations
first, surfaces later; no bundled model, bring-your-own OpenAI-compatible
endpoint. Started 2026-06-09.

- [ ] Step 1 - gateway plumbing (server-only, no surfaces). The
      `$lib/server/llm/` module: `config.ts` (account/story `llm_config`
      read/merge/decrypt + the pure `assistantGate` and save helpers, reusing
      `crypto.ts` and the `storyPreferences` null-clear pattern), `egress.ts`
      (the SSRF guard - pure `classifyAddress`, the block-private / allowlist /
      open policy in `app_settings`, and a connect-time-`lookup` pinned request
      that closes the DNS-rebinding window), `providers/` (the adapter seam +
      the OpenAI-compatible adapter: streaming SSE, buffered complete,
      test-connection probe), and `gateway.ts` (the one entry: config ->
      egress -> provider -> stream/complete, with context-assembly and the
      tool loop left as marked seams). No migration (the jsonb columns and
      `app_settings` already exist). Unit + integration tests across config
      merge/decrypt, the egress IP table and policy, the SSE parse, and the
      gateway gate + real egress denial. Lint, check, unit (305), the new
      integration specs, and build pass locally. Deferred to their own steps:
      the SSE `/api/assistant/*` endpoints, all UI (account/story/admin),
      context assembly, tools, the worker queues, the Assistant-reviewer
      attribution, and chat persistence.
- [ ] Step 3 (pulled ahead of the chat surface - it is pure backend) -
      context assembly. `$lib/server/llm/context/`: `sources.ts` gathers the
      in-scope world (story/universe frame, the current scene + neighbouring
      scene summaries, the chapter/scene skeleton, members-or-mentioned
      entities with quick details/aliases/relationships/per-story notes via the
      existing `storyEntityLists` and `listEntityRelationships`, lore by the
      reserved `activation_mode` with keyword matching, and freeform
      story/universe notes); `assemble.ts` tiers and fits them to a token
      budget and renders a system message, returning the source refs for a
      later grounding step. The gathering is settled design; the budget and
      tier-drop order are kept deliberately simple and marked provisional, per
      the design's "needs a corpus" TODO. Owner-scoped through the story. Unit
      tests (the pure `loreMatches`, `estimateTokens`, `selectWithinBudget`) +
      integration (frame, scene-local, entity + per-story note, lore
      always/keyword/manual activation, notes, owner-scoping, budget drop).
      Not yet wired to a surface; the chat endpoint and co-author/review will
      call `assembleContext` + `buildSystemMessage`.
- [ ] Assistant name + persona (author request - a bit of personality). A
      cosmetic `assistantName` and a fixed-set `persona` tone preset (balanced
      default, concise, professional, casual, encouraging) on the account
      `llm_config`, in a pure `prompts/persona.ts` (the spec's `prompts/` dir).
      Deliberately not a free-form system prompt - tone presets keep the
      Assistant a writing aid and do not reopen the role-play escape hatch the
      design closes. The gateway prepends a persona system message (name + tone,
      "stay in the helper role") to every turn, so the personality is consistent
      across surfaces; any surface-supplied context message follows it. Rides in
      the existing jsonb, no migration. Unit tests (presets, validators,
      `buildPersonaPrompt`) + integration (save/resolve/view round-trip,
      normalisation fallback, the gateway prepend). Frontend (a name field + a
      tone dropdown in the account Assistant section) deferred with the rest of
      the UI.
- [ ] Tools and data retrieval (author request - "get it all ready for the
      front-end"). The agent layer: - Provider tool-calling: `providers/types.ts` gains tool specs, tool
      calls, and a `respond()` turn (replacing `complete`); `openai.ts`
      serialises a `tools` array + tool/assistant-tool-call/tool-result
      messages and parses `tool_calls`. - `tools/registry.ts` + `tools/dispatch.ts`: read tools (`get_scene`,
      `get_entity`, `find_appearances`, `search_text`) wrapping existing
      owner-scoped queries (`getEntityCard`, `entityAppearances`,
      `searchAll`), and write tools (`suggest_edit`, `leave_comment`) that
      _stage_ a review suggestion/comment and never touch authored content
      (the "writes are suggestions" invariant). Every handler is scoped to
      the context's story + user. - Gateway agent loop: `complete`/`stream` run a `respond` loop that
      dispatches tool calls, feeds results back, and repeats until the model
      answers or the account `toolCallBudget` is spent (then tools are
      withdrawn to force an answer). Tools are offered only with a story the
      user owns and an endpoint that can call them (`enableTools`). - Write-as-suggestion attribution: the Assistant is a third review author
      via an additive `assistant` boolean on `review_comments` /
      `review_suggestions` (migration 0052), not a synthetic reviewer row
      (which would need a fake invitation). The display name resolves live
      from the owner's assistant name, so a rename relabels past suggestions
      on the fly; `isAssistant` is exposed on the views for badging. The
      owner accepts/rejects an Assistant suggestion through the unchanged
      decide path. - Unit tests (SSE/tool-call parse, message serialisation) + integration
      (read-tool loop feeds results back; write tool stages a pending
      Assistant suggestion and changes nothing, shown under the assistant
      name and acceptable by the owner; the budget caps the loop; no tools
      without a story). Lint, check, unit (327), the LLM + review
      integration specs, and build pass. Deferred: structural write tools
      (create scene/entity preview-and-confirm), the worker review/enrich/
      summary jobs, and all UI.
- [ ] Endpoint setup helpers (author request - non-tech-savvy setup). In
      `llm/models.ts`, both through the egress guard: model discovery
      (`discoverModels` / `listEndpointModels` over `GET /v1/models`, so the
      writer picks from a dropdown instead of typing a model name) and a test
      connection (`testAccountConnection` / `testEndpointConnection` sends a
      tiny prompt and returns the model's reply, the SMTP "send a test"
      analogue). Both work on the saved config or submitted values, and before
      the master toggle is on (mid-setup). `listModels` added to the provider
      interface + OpenAI adapter (de-duplicated, sorted ids). Note on tools:
      the model "discovers" Codex's tools inline per request (OpenAI
      function-calling), no MCP - tools run in-process and the endpoint only
      needs to pass the `tools` field through to a tool-capable model. Unit
      tests (listModels parse/path/auth) + integration (discovery and test
      happy paths via injected provider, missing endpoint/model, real egress
      denial). UI deferred.
- [ ] Tool-capability detection (finishes the tools work). The probe now sends
      a one-shot forced-optional tool request and reports `supportsTools` from
      whether a tool call comes back (best-effort: any error or a plain answer
      reads as no tools), alongside `supportsStreaming`. `probeAccountEndpoint`
      / `probeEndpoint` in `llm/models.ts` expose it so the setup screen can
      show a "tools: supported / not" line next to the discovered models; the
      flags are meant to be saved onto the config, and the gateway already
      withholds tools when `supportsTools` is false. Unit tests (tool call
      detected / rejected) + integration (capabilities reported, egress
      denial). UI deferred.
- [ ] Account Assistant settings UI (first surface; design handed over by the
      author as a standalone HTML mock). The Assistant section at
      `/account/assistant` on the account sidebar shell: a kill switch (the
      `enabled` master, read inverted - engaged means off - which dims the config
      while off), a privacy explainer card, Identity (name + tone preset from
      `PERSONAS`), Endpoint (base URL + API key, blank keeps the stored key, plus
      a Test connection button), and Models per role (a Discover models button
      fills per-role `<select>`s for all five `ASSISTANT_ROLES`). Wired through
      new form actions (`toggleAssistant`, `saveAssistantIdentity`,
      `saveAssistantEndpoint`, `saveAssistantModels`, `testAssistant`,
      `discoverAssistantModels`) over the existing `saveAccountLlmConfig` /
      `accountLlmView` / `testAccountConnection` / `discoverModels` helpers; the
      tone presets ride through `load` so the client never imports the
      server-only persona module. The design system CSS (killswitch, role-table,
      attn-list) was already ported. Account help article updated with an
      Assistant section; e2e covers the kill-switch / identity / endpoint
      journey (no-network path). Capability probing on this screen and the other
      surfaces (chat, inline, review, admin egress, per-story mute) stay
      deferred. Lint, check, unit (333), the LLM + account integration specs, and
      build pass locally; Playwright could not download a browser in the sandbox,
      so the e2e is unverified locally and left for CI.
- [ ] Chat surface + layout gate + per-story mute (second surface; branch
      `feat/assistant-chat`). The gate finally renders something: a new
      `assistantLayout(db, userId, storyId)` (key-free: `tabEnabled`,
      `surfacesEnabled`, `muted`, display `name`) feeds the story editor's
      `load`, the way asset-backed features hide when no bucket is set, so the
      Assistant tab appears only when the account is configured and on. The tab
      is a fourth peer of Reference/History/Session (`AssistantPanel.svelte`,
      ported from the prototype's chat panel + CSS): an ephemeral, client-held
      transcript, grounded starter chips drawn from the story's cast, a composer,
      and a stop button. It streams from a new `POST /api/assistant/chat` SSE
      `+server.ts` that verifies ownership, assembles context
      (`assembleContext` + `buildSystemMessage`), runs `gateway.stream` with
      `role: 'chat'` + tools, forwards `token`/`done`/`error` frames, and threads
      the request `AbortSignal` for cancel. A per-user `assistantLimit` bounds
      open streams. The per-story mute lives on the tab ("Mute for this story" /
      "Turn on for this story", `muteAssistant`/`unmuteAssistant` actions over
      `saveStoryLlmOverride`); a muted story keeps the tab to un-mute. Editor
      help gained a "The Assistant" section. Integration test covers
      `assistantLayout` (unconfigured / on / muted / master-off); an e2e (in
      `account.spec.ts`, serialised with the kill-switch test) covers tab gating
      and the mute round-trip. Deferred: persisted conversations, reference-in-
      chat, the inline/review/admin surfaces. Lint, check, unit (333), and build
      pass locally; the DB-backed integration and Playwright specs need Postgres /
      a browser the sandbox lacks, so they are written but left for CI.
- [ ] Admin egress panel (the SSRF control; branch
      `feat/assistant-egress-admin`). The admin "AI" section (a "soon" stub
      until now) becomes the egress policy form: a select over `block-private`
      (default, safe for shared instances) / `allowlist` / `open`, plus a hosts
      textarea (one per line) for the allowlist mode, wired through a `saveEgress`
      action over the existing `egressPolicy` / `saveEgressPolicy` helpers
      (`llm/egress.ts`). Plain-language labels, no admin help article needed
      (admin panel). The egress helpers are already unit- and integration-tested;
      the admin area 404s for the seeded regular-user e2e session, so no new e2e.
      Lint, check, and build pass locally.
- [ ] Review surface, single-scene (third surface; branch
      `feat/assistant-review-scene`). The Assistant-as-reviewer path, inline for
      one scene. A new `prompts/review.ts` (`buildReviewMessage`, shipped-fixed)
      tells the model to review one scene and leave its notes through the staging
      tools, never the prose. `POST /api/assistant/review` (sceneId) verifies
      ownership, re-checks the gate, assembles context, runs `gateway.complete`
      with `role: 'reviewer'` + tools, and reports how many notes were staged by
      counting the Assistant's pending suggestions/comments before and after. The
      entry point is "Review this scene" on the left-sidebar scene menu (gated on
      `surfacesEnabled`); a non-blocking banner covers the wait, then it navigates
      to the existing author review screen where the Assistant's suggestions and
      comments already render with their badge. Editor help gained a review note.
      The staging mechanism (write tool stages an Assistant suggestion, owner-
      scoped, budget-capped) is already covered by the gateway integration test;
      a unit test covers the prompt builder. Deferred to the background-jobs PR:
      "Review this chapter", whole-story "Review this story" (the
      `assistant-review` worker job + completion notification), and the palette
      command. Lint, check, unit (335), and build pass locally.
- [ ] Whole-story / chapter background review (branch
      `feat/assistant-review-jobs`). The `assistant-review` pg-boss queue fans the
      reviewer over every scene in scope. Shared `llm/scene-review.ts`
      (`reviewOneScene`, `countAssistantNotes`, `reviewStoryScenes`) backs both
      the inline endpoint (refactored onto it) and the worker job; the job loops
      scenes, catching per-scene errors so one unreachable turn does not abandon
      the rest, then notifies the owner (a new `assistant_review` notification
      kind) with the staged-note count and a link to the review page. Because the
      worker cannot import `notify.ts` (it pulls `$env` via jobs.ts), the
      notification row insert moved to a jobs-free `notify-core.ts`
      (`insertNotifications`) that both `notify.ts` and the worker share; the
      worker queues the digest through its own pg-boss handle. Entry points:
      "Review this story" in the story-settings Review section and "Review this
      chapter" on the editor's chapter menu, both gated on `surfacesEnabled` and
      posting to `POST /api/assistant/review-job` (`queueAssistantReview`, a
      singleton per story+chapter scope). The live OpenAI adapter path (streaming,
      tool-calling, model list) was verified against a real OpenAI-compatible
      endpoint. Deferred: the palette command, and `assistant-enrich` /
      `assistant-summaries` jobs. Lint, check, unit (335), and build pass locally;
      the worker job and notification fan-out need Postgres/the worker, so they
      are left for CI.
- [ ] Inline continuation (first inline surface; branch
      `feat/assistant-continuation`). A CodeMirror ghost-text extension
      (`editor-continuation.ts`, its own keymap/StateField, distinct from the
      entity autocomplete): Ctrl/Cmd+J asks the Assistant to continue the prose at
      the cursor, the suggestion shows as grey ghost-text, Tab accepts, Esc / an
      edit / a caret move dismisses. `POST /api/assistant/continuation`
      (`buildContinuationMessage`, `role: 'continuation'`, no tools) returns the
      buffered continuation; the editor inserts it only on accept (a suggestion,
      never a silent write). Threaded through `SceneEditor` (`storyId` +
      `assistantContinuation` props) in both the single-scene and continuous
      views, gated on `surfacesEnabled`. Editor + shortcuts help updated. The live
      model produced a clean in-voice continuation through the real provider path.
      First-cut product choices (documented for the author to revisit):
      request-on-demand via a keybinding rather than auto-on-pause (cost), and
      buffered rather than token-streamed. Unit test covers the prompt builder;
      the extension/endpoint need a browser+model so they are left for CI/manual.
      Lint, check, unit (336), and build pass locally. Deferred: co-author (the
      side panel with insert/edit/reject), auto-on-pause, and streaming.
- [ ] Co-author (second inline surface; branch `feat/assistant-coauthor`). A
      "Write with the Assistant" button on the editor toolbar opens a panel: the
      writer types a brief, the Assistant drafts a passage grounded in the
      assembled world + current scene, and the writer inserts it at the cursor,
      edits it in place first, or discards it (nothing is written until Insert).
      `POST /api/assistant/coauthor` (`buildCoauthorMessage`, `role: 'coauthor'`,
      no tools, context assembled) returns the buffered draft. UI lives in
      `SceneEditor` (owns the view for insert-at-cursor) with an `onCoauthor`
      trigger added to `EditorToolbar`; gated on `surfacesEnabled`, single-scene
      editor only. Verified live: a strong in-context passage through the real
      provider path. Unit test covers the prompt builder. Completes the inline
      surface. Deferred (own future work): streaming the draft, and the
      structural/enrichment tools, summary jobs, recap, and persisted chat the
      design lists as later.
- [ ] Recap / "catch me up" (first background-enrichment surface, sequencing
      step 7; branch `feat/assistant-recap`). A "Catch me up" control at the top
      of the Assistant tab streams a recap of the story so far - every scene up
      to and including the open one - into the conversation as an assistant turn.
      `POST /api/assistant/recap` (SSE, `role: 'chat'`, no tools) assembles a
      dedicated recap context (`assembleRecapContext` + `scenesUpTo`): the world
      frame, the scenes in order (preferring each scene's summary, falling back to
      a body excerpt since summaries are sparse until summary maintenance lands),
      and the in-scope entities, fit newest-first to a provisional budget
      (`fitRecapScenes`). `buildRecapMessage` instructs a summary of what is there,
      not a continuation. The panel's SSE read was factored into a shared
      `streamInto` used by both chat and recap. Editor help gained a recap
      paragraph. Chosen sub-order rationale: scene/chapter summaries have no
      display UI yet, so summary maintenance is invisible until a consumer exists;
      recap is that consumer and is user-visible on its own, improving once
      summary maintenance lands. Unit tests cover the prompt and the budgeting;
      `assembleRecapContext` gained integration coverage (cut at the focus scene,
      whole-story fallback, body fallback) that needs Postgres, so it is left for
      CI. Lint, check, and unit pass locally. Next in step 7: `assistant-summaries`
      (summary maintenance), then entity enrichment + arc summaries.
- [ ] Summary maintenance (`assistant-summaries`, sequencing step 7; branch
      `feat/assistant-summaries`). A background job that drafts and refreshes
      scene and chapter `summary_md` - the derived metadata recap and context
      assembly feed on. `summariseStory` (`llm/summaries.ts`) fills blank
      summaries, refreshes ones the Assistant generated when the body changed
      since, and never overwrites a summary the writer wrote by hand. Provenance +
      staleness via a new nullable `summary_generated_at` watermark on scenes and
      chapters (migration 0053, additive); the summary write preserves the row's
      `updated_at` so it neither registers as an edit nor looks stale next run, and
      chapter summaries refresh when their scenes were re-summarised this run.
      Triggered by "Update summaries" at the top of the Assistant tab ->
      `POST /api/assistant/summaries-job` -> `queueAssistantSummaries` (singleton
      per story); the worker calls the gateway directly (`role: 'chat'`, no tools,
      summaries are generated metadata not staged suggestions) and notifies on
      completion (new `assistant_summaries` notification kind). Editor help
      documents it. Unit tests cover the prompt builders and the `needsSummary`
      decision matrix; an integration test with a stub provider covers the DB
      behaviour (fill/skip-handwritten/refresh, `updated_at` preserved, chapter
      from scenes) - needs Postgres, left for CI. Lint, check, unit, and the worker
      import-resolution check pass locally. Next in step 7: entity enrichment +
      character arc summaries.
- [ ] Entity enrichment (sequencing step 7, the deferred suggestion machinery;
      branch `feat/assistant-entity-enrichment`). The Assistant suggests new
      aliases, quick details, and a summary for an entity, staged as suggestions
      the writer accepts or rejects in the entity editor - the design's "lands as
      suggestions on the entity, not an overwrite". New `entity_suggestions` table
      (migration 0054, additive): polymorphic (entity_kind + entity_id), field
      alias|detail|summary, owner-scoped. `entity-suggestions.ts` stages (dedup
      against existing aliases/detail-labels/summary), lists pending, and decides:
      accept applies the one field across the three entity kinds (lore alias ->
      keywords) and records a 'suggestion' revision (so it shows in History and
      rolls back); an accepted alias requeues the universe mention index. Inline,
      sync generation: `enrichEntity` (`llm/enrich.ts`) reads where the entity
      appears (`entityAppearances`), asks for a JSON object (no gateway tools, so
      it works on any endpoint), and `parseEnrichResponse` pulls and validates the
      JSON defensively. `POST /api/assistant/enrich` (gated) returns staged
      suggestions; `POST /api/assistant/entity-suggestions/[id]` accepts/rejects
      (no gate - acting on an existing suggestion). UI: a "Suggest details with the
      Assistant" button + an accept/reject panel in `EntityEditor`, fed by the
      story plan load (gate + pending suggestions for the selected entity);
      accepting also applies to the open editor's state without a redundant save.
      Planning help documents it. Unit tests cover the prompt + the defensive JSON
      parse; an integration test (stub provider) covers stage/dedup, accept-applies
      per field, reject, owner-scoping, and enrichEntity end-to-end - needs
      Postgres, left for CI. Lint, check, and unit pass locally. Whole-universe
      background `assistant-enrich` and character arc summaries remain for later.
- [ ] Provider presets + native Claude adapter + usage log (2026-06-12; branch
      `claude/dreamy-ride-h5glzt`). First-class providers for the Assistant:
      `providers/presets.ts` (Claude, ChatGPT, Gemini, DeepSeek, OpenRouter -
      label, locked base URL, key hint, docs link) with a `provider`
      discriminator on the account config (jsonb-only, legacy configs normalise
      to 'custom'); a preset owns its endpoint server-side, and the Anthropic
      preset pins streaming/tools capable. `providers/anthropic.ts` is the
      native Messages API adapter behind the same Provider interface (system
      hoisting, tool_use/tool_result mapping with adjacent-tool-turn merge,
      typed SSE events), picked by `providerFor` in `gateway.ts` and
      `models.ts`. Model discovery returns `ModelInfo` (id + per-token pricing
      where reported - OpenRouter); the settings page gains a provider picker,
      a filter box over large model lists, prices per 1M tokens on the options,
      and a pricing snapshot saved at discovery. Usage log: `assistant_usage`
      (migration 0062, metadata only - role, model, token counts; never prompt
      text), recorded by the gateway around every provider request (the
      streamed usage frame is consumed server-side), shown on the account page
      with 30-day totals and estimated costs where prices are known. Help
      (account.md) and assistant.md updated. Unit tests cover both adapters,
      presets, and the Gemini base-URL quirk; integration covers preset save
      enforcement, real provider selection through the gateway, usage
      recording, and the pricing snapshot. Lint, check, and the full vitest
      suite (973) pass locally; Playwright could not run in this sandbox
      (browser download blocked), left for CI.

## Capability review follow-ups (2026-06-06)

A general capability review (six survey passes over routes, design docs,
content lifecycle, sharing, ops, and help docs, contested claims verified
against the code) found five gaps that read as oversights rather than
deferrals. Agreed 2026-06-06: these close out the current phase; the
softer findings went to the roadmap as candidates for the next phase.

- [x] 1. Chapter management + scene delete. Chapters gained hover tools
     (inline rename, move up/down, delete; deleted chapters drop their
     scenes to a new "Unfiled scenes" list, author's call 2026-06-06), and
     scenes gained a trash (scenes.deleted_at, migration 0036): one click
     deletes into a "Deleted scenes" sidebar section with restore and a
     confirmed delete-forever that cascades markers, mentions, revisions,
     review threads, and outline links. Trashed scenes leave every live
     read (board, story view, exports, search, todos, insights, ordering,
     APIs) and the mention rebuilder clears trashed scenes so a queued
     rebuild cannot resurrect them. Merged 2026-06-06 (#147), shipped as
     v2.19.0.
- [x] 2. Find/replace + full-text prose search. The editor gained the
     @codemirror/search panel (Ctrl+F, find as you type, replace one or
     all) through the shared prose extension base, styled to the design
     system; the palette's search now also matches scene bodies and
     returns "In the text" results with a SQL-computed snippet, owner
     scoped and trash-aware, backed by pg_trgm and a trigram index over
     scenes.body_md (migration 0037). Merged 2026-06-06 (#151), shipped
     as v2.20.0.
     Items 3-5 (markdown import, export completeness, review notifications)
     are still open; they live in the Open section at the top of this file.

## Design alignment (author feedback, 2026-06-06)

Playing with the app surfaced two screens that had drifted from the
app-design prototype; both ported from the design files, shipping as
their own releases.

- [x] Library dashboard (dashboard.html): page header with totals and a
      New universe button, Recent row, universe sections with description
      and Edit universe, story cards with a derived status pill and
      chapters/words/edited meta, dashed new-story card per universe (new
      root createStory action). storyStatus/relativeTime helpers unit
      tested; new dashboard e2e spec. Standalones section skipped (every
      story has a universe by schema). Merged 2026-06-06 (#154), shipped
      as v2.21.0. The suite refactor it forced - one shared signed-in
      session instead of sixteen logins against a fifteen-per-window rate
      limit - landed first as #153.
- [x] Universe settings (universe.html): header eyebrow + title, Contents
      stat tiles, an Entity categories manager (first of its kind in the
      app, with guarded deletes), History with filters/day grouping/kind
      chips/checkpoint preview+restore (scenes joined the universe
      timeline), a universe markdown export (extracted from the account
      builder), Stories section moved to the dashboard, and the danger
      zone became a cascade soft-delete with a 30-day restore window
      (author's call): universes.deleted_at (migration 0038), a Deleted
      universes block on the library with restore/delete-forever, and an
      hourly worker purge sweep. The shared cascade fixed two account
      purge leaks (custom relation types, entity revisions). Lorebook
      JSON export stays in Phase 9. Merged 2026-06-06 (#156), shipped as
      v2.22.0.

- [x] Session pane + plan flow fixes (author feedback, 2026-06-06): the
      Insights segment navigated away while its siblings switch views in
      place, so it left the left pane; the right column gained a Session
      tab (story write, story plan, universe plan) with today's words
      (story-scoped on story screens), the week's writing days, the
      streak, and an "All insights" link - the prototype's Session panel
      on real data, fetched lazily through a new session endpoint. The
      story plan gained a pinned "Scene board" row to get the board back
      after opening an entity, and folded "In the universe" lists showing
      non-member characters and places. Merged 2026-06-06 (#160), shipped
      as v2.23.0.

## Click-through feedback (2026-06-06)

A stream-of-thought pass over the whole app; triaged into batches, each
shipping as its own PR.

- [x] Bugs: a reload inside the autosave debounce dropped a scene rename
      for good (pagehide keepalive flush + commit-on-blur, new e2e spec);
      the Reference pane stayed stale because the post-save refresh raced
      the worker's mention indexing (bounded watermark poll); chapter
      rows got pointer cursor + hover back; right-click menus keep the
      native arrow cursor; the dashboard topbar gained the brand mark.
      Merged 2026-06-06 (#162).
- [x] Quick wins: opening a story resumes the last-edited scene; palette
      gained a Focus mode toggle and "Read the whole story", and a text
      match jump selects the occurrence in the editor; "All insights"
      marks that it leaves the view; new universes seed a "Faction"
      category; slugs follow names (slug fields removed from universe and
      story settings, renames move the address). Merged 2026-06-06
      (#163). Both batches shipped as v2.24.0.
- [x] Editor design alignment: mention autocomplete popup per the
      prototype (coloured badges, kind labels, key-hint footer; shared
      names show once per entity); entity hover card per the prototype
      (badge + kind line with category, summary, detail chips, related
      chips from a one-pass relationship summary, "Open full details");
      the formatting toolbar became the prototype's full-width sticky
      bar at the pane top. The Obsidian-style live preview the feedback
      asked for already existed as the rich editing mode - it just was
      not the default, so the default flipped to rich (stored
      preferences stand). Merged 2026-06-06 (#165), shipped as v2.25.0.
- [x] Plan-page alignment: both plan pages keep the same
      Reference/History/Session pills with an empty-state hint; the
      universe plan's empty centre became a read-only story board by
      derived status with a pinned "Story board" row; "In the universe"
      lists start open, styled as real sections; the write page's
      sidebar header became the prototype's book switcher; the Outline
      view retired (migration 0039 drops outline_nodes + its revisions;
      module, routes, editor, docs all removed - scene status + the
      future Notes tab cover it); the admin shell rail widened to the
      editor's 264px so screens stop shifting (follow-up feedback).
      Merged 2026-06-06 (#167), shipped as v2.26.0.
- [x] Preferences and left-menu search: a "Writing streak" preference
      under Editor behaviour hides the Session tab's streak card (the
      session endpoint nulls the streak, so the panel needed no
      plumbing); filter fields top both left panes, built as instant
      list filters (not a second search) so they complement the palette.
      Merged 2026-06-06 (#169).
- [x] Rename propagation (follow-up feedback): renaming an entity now
      offers - once the rename settles, no dialog mid-autosave - to
      replace the old name across the universe's live scenes: whole-word
      and case-sensitive via mention detection's boundary rules, aliases
      untouched, marker anchors carried through the edit, a labelled
      checkpoint revision per changed scene, mention rebuilds queued.
      Merged 2026-06-06 (#170). Both shipped as v2.27.0.

## Feedback backlog

From first real use (2026-06-03):

- [x] Scene marks in the continuous view should be hideable: shipped with v1.10 (continuousSceneMarks preference)
- [x] Editable continuous view: shipped with v1.10 (roadmap step 23b)
- [x] Spell-check from a user language preference (Phase 7; browser-native first). Shipped 2026-06-05 (#126): spellCheck on by default + writingLanguage (BCP 47, blank follows the browser), account-level with per-story overrides.
- [x] Markdown affordances: the shared renderer shipped with v1.12 (exports + print); reading pages pick it up in step 27; in-editor styling and the prototype's toolbar shipped 2026-06-05 with the Phase 7 rich editing item.
- [x] Preference layering: user-level preferences with per-story overrides merged at render time (same pattern as llm_config); story-level column is an additive migration (Phase 7, prerequisite for the rich-editing choice below). Shipped 2026-06-05 with the Phase 7 item above.
- [x] Default editing format preference (Phase 7; reordered there on 2026-06-04). The editor is CodeMirror over raw markdown today; a writer should be able to choose a softer, Word-like editing surface rather than seeing markdown syntax. A rich/WYSIWYG editing mode behind a preference, settable at user level with a per-story override. Builds on the "markdown affordances" and "preference layering" items above; that is the foundation, this is the user-facing choice on top. Shipped 2026-06-05 with the Phase 7 rich editing item (CodeMirror live-preview, not a separate WYSIWYG editor).
- [x] Entity colours with meaning: shipped with v1.2 (characters/places join categories; badge takes the category colour)

From the pre-v1.0 code review (2026-06-03); the four fixable findings were fixed:

- [x] Page setup for print/PDF (Phase 7, alongside preference layering): page size incl. book trim sizes, margins, font and size, paragraph style (indent vs spaced), scene-break glyph, page numbers and running headers (puppeteer displayHeaderFooter; Chromium lacks @page margin boxes), and explicit in-chapter page breaks (a scene-level flag or markdown marker styled with break-before). All of it parameterizes the one stylesheet the print route and the worker PDF already share; EPUB stays reflowable by design. Known wall: mirrored facing pages (@page :left/:right) are unsupported in Chromium; real bookbinding output would need a different typesetter. (Broadened 2026-06-05 from the original page-breaks note.) Shipped 2026-06-05 with the Phase 7 page setup item.
- [x] Mention attribution is first-match when two entities share an identical name or alias; needs a dedupe/disambiguation design (mention-detect.ts) (Phase 7). Shipped 2026-06-05: deterministic order (pin > story members > character > place > lore > primary name > id) with per-story pins (mention_pins, migration 0034) picked from the hover tooltip; dotted underline marks ambiguity. (#130)
- [x] Hover tooltip re-runs full-document detection per hover; read from the existing decoration set instead (editor-mentions.ts). Fixed 2026-06-05 (#127).
- [x] applySceneOrder issues one UPDATE per scene; batch into a single statement when stories grow (scene-order.ts). Fixed 2026-06-05 (#127): one UPDATE over unnested arrays.
- [x] updateMarkerAnchors issues one UPDATE per anchor in a loop; batch it the same way (markers.ts). Fixed 2026-06-05 (#127).

From a pre-v2.0 self-review (2026-06-04); the cover IDOR and the duplicated media-types map were fixed:

- [x] The worker-indexed find-usages e2e assertion was timing-flaky on loaded CI runners. Widened the toPass window to 60s, then (v2.1) marked the journey test slow and switched to set-membership assertions, then gated test start on worker readiness (global-setup waits for the worker's "started" log before any test relies on the async index, and captures its output to a file). Recurred across the v2.0.1 and v2.1 release runs each time, so chased to the readiness race rather than re-running.
- [x] Worker job enqueue is best-effort and silently drops on failure (jobs.ts), so a dropped mention rebuild left the index stale until the next save. Fixed 2026-06-04: scenes gained a mentions_indexed_at watermark (migration 0025), set inside rebuildSceneMentions; a five-minute reconcile-mentions sweep in the worker re-indexes any scene whose body or whose universe's entities changed after the watermark, so a dropped rebuild self-heals within minutes regardless of cause. The fast-path enqueue stays for low latency.
- [x] Entity History is body-only: changing an alias or relationship records no revision, and Restore only returns the body (the alias save dedupes on the unchanged body; relationships save through their own endpoint). Author wants full-snapshot entity revisions, in Phase 7 alongside the jsonb quick details (the snapshot must capture them). Fixed 2026-06-05 with the Phase 7 quick details + history item (#117).
- [x] CI never ran the Docker image, so a broken worker import closure shipped silently (caught by hand at v1.6: src/lib was missing from the image since step 14). Fixed in v1.6.1 with a docker-smoke CI job that builds the image and boots compose with a worker check

Later phases tracked in the roadmap until they get close.
