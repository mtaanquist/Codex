# History

How shipped work was built: the reasoning, what was tried, and what was
deferred. These notes used to live in `TODO.md`; they moved here verbatim on
2026-10-29 (#630). `TODO.md` itself was retired on 2026-11-18: its open items and shipped
steps became GitHub issues grouped in milestones.

Newer notes go at the top of the matching section. Each note names its
version, date, branch or PR where it had one.

## Notes from the Open list

The narrative that sat under `## Open` in `TODO.md`, newest first, as it was
written at the time.

Small non-Assistant polish (2026-11-20, staging branch
`staging/non-assistant-polish`, lanes #1278 to #1284): six backlog issues.
`resolvePlanEntity` is one select with a left join per entity table instead
of up to three round trips (#860). Side columns: a double-tap resets a width on
touch, the pre-paint script takes only the chosen width from storage and
rebuilds the floor and cap, and the settings rail keeps following the left
width with no handle of its own, now tested (#1005). The sign-up form asks
"What are you working on?" under approval mode, stored in `users.signup_note`
(migration 0090) only for a request that waits, and shown in the admin
approval list (#853). Sign-in by emailed link at `/login/link` (#852): a
`sign_in` token kind (no migration; the kind column is text), 15 minutes,
single use, sent only to an account that could sign in with its password. It
replaces the password step only, so two-factor still follows; the shared
steps after the first factor moved to `continueSignIn`. Considered and left
out: letting a link confirm an unverified address, and skipping two-factor
the way a passkey does. A confirmed email change now revokes sign-in and
reset links mailed to the old address. The review toolbar (#851) brings bulk
accept and reject back as a list the author ticks, not a button: it loops the
existing `decideSuggestion`, so there is no second write path, each accept
gets its own history entry, and the open editor is saved first. One
transaction for the whole batch was considered and dropped: it would have
been a new lock path for the lock-order harness and a new place for stale
marks, for no gain a writer would see. Tooling (#1262): the stale-marks
coverage guard runs up to 8 further seeds while an action has yet to apply
(a separate random stream for the rare actions was tried first and only moved
the thin margin to other actions), and the lock-order harness holds the
revision lock of every scene and entity. The first staging review found
an older bug the toolbar would have made worse: the open editor applied an
accepted edit at its mark, which leaves out white space at the edges of the
range, while the server replaced the whole range, so an edit ending in a space
left a doubled space that the next save stored. `applyAccepted` now widens to
the stored range, and with nothing unsaved it takes the server's text when a
change cannot be made locally. The second review caught that fallback
putting one scene's text into another scene's editor (an accept from a guided
pass while a different scene is open), so the editor now ignores an accept
whose edits are not its own scene's. The third review narrowed it again: the
server's text is taken only when the accept was made on text this editor
saved, a card's accept saves the open editor first (as the pass and the dialog
do), and an insertion is not applied over unsaved typing, where its place
cannot be checked.

Codebase review round (2026-10-19, staging branch `staging/review-fixes`):
review agents covered correctness, security, tech debt and reliability, and
every finding was filed as an issue (#572 to #630), plus the Assistant retry
notice (#638). All of them are fixed on staging; the SvelteKit 3 upgrade (#613)
followed in the 2026-10-26 issue round. Partly done, with the rest left open on the issue: dependency
hygiene (#616, since done in the 2026-10-26 issue round: Node 26 runtime and
engines, drizzle-orm 0.45.4),
action error codes (#627, since done in the 2026-10-26 issue round), the hygiene sweep (#629, one fixed locale, large-file splits) and
the docs pass (#630, the TODO.md format proposal waits on the owner).
Follow-ups: the worker's purge schedules have no test, `resolvePlanEntity`
still queries the three entity tables in turn (#623), and end-to-end CI still
retries twice, which hides flaky tests (#621). Release notes for the
staging merge: the app port binds to 127.0.0.1 by default (`APP_BIND`); the
app and worker refuse to start without `ORIGIN`; restart the worker with or
before the app; worker logs are JSON events (`worker.started` replaces
"Worker started"); the worker container is capped at 2 GB by default
(`WORKER_MEM_LIMIT`); SimpleWebAuthn 14 needs one manual passkey check on a real
authenticator before release.

Assistant fixes and codebase review (v3.20.0, 2026-10-20, PR #716 and #646):
a provider switch now clears the old key and models and Test connection saves
before it tests (#649); each role suggests a model for Claude and hints at the
kind of model for other providers (#655); Claude context windows come from the
API (#683); the chat and world context budgets scale with the model window,
capped for cost (#685); older side panel turns are summarised on the utility
role instead of dropped (#686). Ships with the 2026-10-19 codebase review fixes.

Assistant settings, per-role tuning (2026-08-26, author-scoped, branch
`claude/llm-assistant-work-paths-puxtka`): the five tuning controls added with
the work below had been crammed into the role table's 280px column, where the
browser truncated their placeholder labels to "Te" and "Lo" and their
explanations sat six paragraphs below the boxes they described. Each role's row
now carries the model select, a summary of what the role is tuned to, and a
Tune button opening `RoleTuningModal`, where every control has a real label and
its own hint. Temperature and reply length gained a `.slider` primitive paired
with a number box (the slider steps in 0.05 and 128; the box still takes any
figure) and a "use the default" checkbox, because a range input cannot express
an unset value. The modal holds its changes and the page saves once on close,
whichever way it is closed, and only when something was actually touched; a
figure outside its bounds, or extra settings that are not JSON, hold the panel
open rather than closing over a value the save would discard. `$lib/assistant-tuning` now holds the roles, the
effort levels, the value bounds, and `RoleTuning` itself, so the settings page
and the server config stop spelling them separately (the page had a hand-copied
copy of the tuning shape, and the modal would have been a third).

Per-endpoint request settings (2026-08-24, issue #550 phase 1, branch
`claude/llm-assistant-work-paths-puxtka`): an `extraParams` JSON object on the
account config, and a second one per role laid over it, merged into every
OpenAI-compatible request body so a writer can send whatever their server
expects (an Unsloth or vLLM reasoning switch where the llama.cpp
`chat_template_kwargs` spelling does not fit, sampler settings Codex has no
field for) without Codex hardcoding each dialect. The fields the adapter owns
are refused on save and stripped on read. Plus a per-role reply length
(`maxTokens`), which overrides what the surface asks for, and content-part
answers read correctly now (a server running its own tools replies in parts,
which both parsers used to drop).

Phase 0 in the same branch: a new help article, `established-settings.md`, on
writing in a published world - mark the universe established, then put the
canon you actually want checked into lore, where it becomes the ordinary
continuity check on any endpoint. Phase 1b too: an account opt-in that attaches
Anthropic's `web_search` server tool, only on the Claude provider and only on
an established universe, capped at five searches a turn.

Phase 2 of #550, a Codex-side `search_web` tool against a search API Codex
holds a key for, is dropped rather than deferred (owner decision, 2026-08-24).
Telling the endpoint to search covers the use case: Anthropic's server tool
above, or a search switch pasted into `extraParams` on any OpenAI-compatible
endpoint that has one. Both keep the search on the provider's servers, leave
the only outbound destination the configured endpoint, and keep raw web
results out of the tool loop. Codex operating a search client would give up
all three, so it is not a "later" item.

Low-context LLM pass (2026-08-17, author-scoped): make the Assistant work
well against local OpenAI-compatible endpoints with 32-64K context windows,
and guard cost against usage-billed APIs. All 27 issues (#526-#552) on one
staging branch `claude/llm-low-context-optimization-2t2ccu`, squash-merged to
develop as a single PR. Highlights: stable review context hoisted out of the
per-scene loop for prompt-cache reuse; two-stage (survey/confirm) continuity
pass replacing the read-every-scene design; per-model context windows
(discovered and manual) driving get_scene caps and an agent-loop overflow
guard; finish_reason and reasoning-model handling, per-role temperature and
thinking suppression; tolerant quote matching and server-side note dedupe;
resumable review jobs with progress, per-scene failure reasons, and a
summaries-first phase; pre-flight token/cost estimate with a warning
threshold and a per-run spend cap; a utility role for summaries, extraction,
and recap; per-role model guidance in settings and help. Audited post-PR by
four independent review passes (state machine, LLM semantics, data layer,
conventions); the confirmed findings were fixed on the same branch, the
largest being job expiry against double execution, capped-run resume by
scope adoption, and keeping tools offered (tool_choice none) on concluding
rounds.

UX pass (2026-07-30, author-scoped after the design pass; steers taken up
front: book-cover library grid, Notes to the right rail only, invites as an
admin-set allowance of single-use codes, all designed in-repo). One branch per
item off develop; all seven merged the same day (#512-#518) and shipped as
v3.17.0:

- [x] Account auto-save (branch `feat/account-autosave`): the Profile and
      Assistant sections drop their save buttons and save on field exit or
      change, like the other four sections already did. One-shot actions
      (claim handle, enable publishing, test connection, discover models,
      everything in Security) keep their buttons. `autosubmitForm` learned to
      skip `data-no-autosave` controls (the model filter box), a discovery
      result now outlives the next action result, and removing a profile link
      saves itself. account.spec reworked for blur-driven saves with
      alternating values so repeated runs against a persistent database stay
      deterministic.
- [x] Import modal: a shared Modal primitive and drop-zone file picker; the
      two-step import (upload, preview collisions, confirm) moves into a
      modal opened from the library and the universe settings page, so
      importing no longer lands next to the danger zone.
- [x] Library covers: the landing page renders stories as 2:3 book covers
      (uploaded cover or the SVG fallback), themed with tokens; the library
      load learns cover_asset_id.
- [x] Notes to the right rail: Notes leaves the left mode strip (Write /
      Plan / Review remain); the right-rail Notes panel becomes the way in
      everywhere, including both Plan views (holding the open entity's
      notes), with an open-in-full link to the Notes page. Plus quick note
      capture: a floating jot affordance on a shortcut that saves to the
      story's notes without leaving the editor (backlog item folded in).
- [x] User invites: admins grant a per-user allowance; users generate
      single-use codes from a new account section; codes auto-approve the
      invited account. Additive migration, admin control, help article.
- [x] Pen name on publish (backlog item folded in): publishing or claiming a
      handle with no pen name set asks for one, display name as the offered
      default.
- [x] Public page preview (author request 2026-07-30): the owner can open
      their own `/@handle` page as a preview even while it is not public,
      marked as visible only to them.

Public surfaces (2026-07-30, branch `feat/design-public-pages`). The fourth and
last design-pass brief's result, ported: everything a signed-out visitor sees.
`src/lib/styles/public.css` is a new layer loaded last, and the `.landing-*`
block is deleted from `pages.css`. One public shell now covers the landing
page, sign-in, sign-up and every page an email link lands on: `.public-surface`
over `AppBar` with a fourth reduction (`shell="public"`: brand linking home,
theme and help, no path) and `ReaderFooter` with a public reduction, so
`AuthShell` is the card inside that shell rather than a frame of its own. The
landing page shows the workspace instead of describing it: a `.ws-*` figure
drawn from tokens, correct in all three themes, with a real three-way posture
tablist (Novelist, Worldbuilder, Game master) carrying the same keyboard
contract as `PanelStrip`, then four model statements in sentences and the
reading pages' footer. The owner's ratified amendments: sign-in keeps email and
password, the passkey button and forgot-password (no magic link); sign-up keeps
display name, email, password and the invite code with every existing mode and
sent state (no "what are you working on" field); and the open/closed switch is
now mode-aware through `signupOffered()` in the new `$lib/signup-mode.ts`,
which offers sign-up under approval and open but not under invite, where a
codeless visitor could not finish one. New help article
`src/lib/docs/selfhosting.md`, so every handbook link on these pages reaches an
article that exists. Deferred to the backlog: magic-link sign-in, the sign-up
work note, a public searchable library, an instance-role setting, and an
offline desktop app.

Secondary surfaces (2026-07-30, branch `feat/secondary-surfaces`). The third
design-pass brief's result, ported. The right pane is now one model: five
panels (Reference, Comments, Assistant, History, Notes) in one order with one
label each, hidden where they have no subject, decided in `$lib/panels.ts` and
rendered by one `PanelStrip.svelte` that is a real tablist (roving tabindex,
arrows, Home/End, `aria-controls`). One panel left means a `.panel-head` title
rather than a one-segment strip (Notes mode's fake History pill, guest review,
insights); no panel left closes the pane (Plan with nothing open). Review's
pane is Comments plus Assistant, with the Open/Done filter moved inside the
Comments panel. The Session tab is gone: its stats are the new "Writing
sessions" section of a universe's Insights, which became a workspace view
(mode strip with no mode current and a `.mode-note` saying why, its section
anchors as `.contents-nav`, the Assistant alone on the right). Write gained a
Notes panel over the existing `notes.scene_id`, with "New note on this scene".
The reading pages are rebuilt on tokens (`.reader-shell`, one footer, covers
as the story's own title in the serif, AA links underlined in the body
colour), and they follow the reader's system theme live until the reader
chooses. The library has one creation pattern: a New menu per collection
(`NewMenu.svelte`), no dashed add tiles in populated grids, no import text
links. Deleted: `SessionPanel.svelte`, `/api/universes/[id]/session`, and the
`.sess-*`/`.streak-*` CSS. Deferred: a Notes panel on Plan (a note attaches to
a scene, and there is no column for an entry, so it needs a migration), and
chapter-by-chapter reader pagination (the reading page still renders the whole
edition with an in-page contents list).

Navigation model (2026-07-30, branch `feat/navigation-model`, PR #507). The
second design-pass brief's result, ported. One `AppBar.svelte` over
`src/lib/styles/chrome.css` replaces the editor's `.topbar`, the pages'
`.page-shell .topbar` with its `.back-link`, the print page's one-off bar and
`.review-guest-bar`, in three shells (author, guest, reader). The two
contested decisions landed as the owner ratified them: a place in the path is
a menu, so the universe and story names open everything belonging to them
starting with "Go to the ...", with no gear anywhere in the chrome; and the
help modal is deleted, the `?` now navigating to the help pages, lighting up
while there and returning when pressed again. Paths are built in
`$lib/chrome.ts`; the theme tool cycles dark -> light -> warm through
`theme.ts` (`cycleTheme` replaces `flipTheme`, and the avatar menu walks the
same cycle); the mode strip is always four, with a rendered note where a mode
is unavailable. Every page that escaped a shell now has one: docs, print,
guest review, and the public reader. `/docs` became public, because the guest
and reader shells keep the help tool. Deleted with it: `HelpModal`, `TopBar`,
`PageTopBar`, `PaletteButton`, and the `.topbar`, `.crumbs`, `.back-link`,
`.breadcrumb`, `.save-status`, `.review-guest-bar` and `.universe-edit` CSS.
New kit card `scratch/design-kit/appbar.html`. Deferred on purpose: the mock's
universe-overview restructure (the Plan page keeps its `PlanSidebar` entity
list, gaining only the bar, the four-mode strip and a small Insights link),
and full reader retheming, which is session 3.

Visual design pass (2026-07-29, branch `worktree-design-system-sheet`).
Groundwork for a whole-app cohesion pass with Claude Design: a components
sheet written from a full audit of `src/lib/styles/` and
`src/lib/components/` (`scratch/system-design/design-system.md`, now
referenced from CLAUDE.md as required reading for page work), and four
session briefs for Claude Design
(`scratch/system-design/design-pass-prompts.md`): landing page,
navigation and wayfinding, secondary-surface cohesion, and a primitive
consolidation sheet. The audit found the drift the briefs target: 20+
button skins, 9 menu systems, 3 modals, ~400 lines of dead CSS,
hard-coded colours bypassing tokens, and four pages outside any shell
(docs, print, guest review, public reader). Also on this branch: a
reconciliation pass over `design.md` against the shipped app (the AI
section rewritten for the shipped Assistant, continuous-view editing,
EPUB/PDF exports, the four sign-up modes, the flat shelf with links and
commissions, scene-mark preferences, plus a new "Beyond the writing
surface" section stating what review, insights, goals, notifications,
print, import, and admin are each for), the stale status header in
`assistant.md`, and three stale schema comments (`llm_config` twice,
`cover_asset_id`). Next: build the design kit preview bundle
(`scratch/design-kit/`, one card per canonical primitive in all three
themes, DesignSync-ready), run the briefs in Claude Design, port the
results, then the code-side consolidation refactor the sheet's backlog
section lists.

Primitives consolidation (2026-07-29, branch
`feat/primitives-consolidation`). The fourth brief's result, ported.
New `src/lib/styles/primitives.css`, loaded last, owns the families that
had no single owner: the modal, the empty state, the chip remove
affordance, and the shared focus ring. `.btn` is now the complete family
(states plus `.btn-accept`), `.icon-btn` gains `.sm` and `.danger`,
`.seg` gains `.seg-count`, and `tokens.css` gains the seven-step type
ramp, `--danger-contrast`, and a per-theme `--select-caret`. Migrated
across the app: the `.rv-btn` family, `.rv-quick-btn`, `.rb-btn`,
`.mini-btn`, `.tool-btn`, `.send-btn` and `.pop-open` onto `.btn`/
`.icon-btn`; `.rtabs`, `.rv-filters`, `.rv-mtabs` and
`.revision-filter-chip` onto `.seg`; the three hand-rolled modals onto
one primitive; twelve empty-state spellings onto `.empty-state`. About
1,400 lines of CSS deleted, including the drift sheet's dead blocks
(`.ctx-menu`, `.settings-nav`, `.note-card`, `.icon-button`, `.kbd`).
Remaining from the sheet's backlog: the duplicated component blocks
(assistant chat, `.insp-*`, kanban), the residual bare `#fff`, and focus
reachability on the sidebar rows.

Dev environment automation (2026-07-28, branch
`feat/dev-env-automation`). Setting the project up on a fresh macOS
machine turned up three things CI never sees, all fixed here.
`npm run test:e2e` did not work as documented: the app reads
`process.env` directly, CI supplies `ASSET_S3_*` as job-level variables,
and nothing loaded `.env` locally, so asset storage looked unconfigured
and every export spec timed out waiting for a button that never
rendered. `playwright.config.ts` now loads `.env` with Node's built-in
`process.loadEnvFile` (no new dependency; shell variables still win, so
CI and one-off `DATABASE_URL` overrides are unaffected), and
`compose.dev.yaml` gained the MinIO the export and upload paths need.
Two specs hardcoded `Control+f`, `Control+k`, and `Control+End`, which
are Linux-only against CodeMirror's `Mod-` bindings, so they could never
pass on macOS; they use `ControlOrMeta+` now, like the rest of the
suite. `goals.spec.ts` was not idempotent against a persistent database
(it refilled the stored value, so no save fired and the "Saved." toast
never appeared), and now picks a value that differs from what is there.
Also added `npm run restore:prod-copy`, which restores an off-site
backup into a separate `codex_prod_copy` database and drops the
`asset-storage`, `smtp`, and `backup-storage` rows the dump carries;
left in place they point local work at the real buckets and relay, and
reading one without the source `APP_SECRET` throws rather than failing
soft, which breaks every page that resolves asset storage. Three
parallel-load flakes remain (`account`, `author-review`), unchanged by
this work and green when run serially; worth a look separately.

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

Write/Review sidebar parity (planned 2026-06-17, design note
`scratch/system-design/write-review-unification.md`): Write and Review
stay separate views (merging them was considered and rejected); the
goal is only to make the two left sidebars uniform. Today the Review
sidebar (`ReviewNav`) is a reduced reimplementation of `StoryOutline`
with no right-click menu, rename, create, drag, or trash. Plan: reuse
`StoryOutline` on the Review route and delete `ReviewNav`, leaning on
its relative form actions plus matching actions on the Review route
(thin wrappers over `scene-lifecycle`). Sequenced in the note:
(1, done) lift create into `scene-lifecycle`; (2) Review-route
management actions via a shared factory; (3) one outline component with
a capability surface (`onSelectScene`, `trailingMeta`, `header`,
`canManage`), guest read-only; (4) `use:enhance` so neither route does
a full reload. All five steps shipped on branch
`claude/blissful-lamport-oqul5f`. A local visual/e2e verification pass
(2026-06-17) ran the new `review-sidebar` e2e plus the Write backstop
and found two regressions from the full-reload to in-place-refresh
shift, both now fixed: the Review scene selection was a writable
`$derived` of `?scene` that `invalidateAll()` recomputed away, so saving
a comment or accepting an edit snapped the view off the in-page-selected
scene (now plain state forked from the URL, re-synced only on a real
`?scene` change); and `StoryOutline`'s `trashOpen` no longer reset
without a remount, so a reopened trash lingered (now collapses when the
list empties). Full e2e green except export/goals specs, which fail the
same way on the pre-change baseline here (environment, not this work).

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

Assistant presentation polish (author feedback, 2026-06-13), in
progress on `claude/trusting-thompson-vphxd3`: (1) the five "Review
scene for X" row-menu items collapse into one review modal that picks a
level (scene, chapter, story) and a set of categories, reachable from
the sidebar row menu, the command palette, the Review pane, and the
chat's `/review`. The review pipeline now carries a category set
(empty = sparing notes, all three = full) end to end - shared
`review-shape.ts` type, the prompt builder, both endpoints, the
`assistant-review` job, and the worker; review.ts focus enum retired.
(2) Queued reviews and the summary pass surface in a new client-side
activity center (Azure-portal style): a running card with a spinner
that polls `/api/assistant/job-status` to completion (queue functions
return the job id; `getAssistantJobState` reads pg-boss). Replaces the
browser alerts on review/summaries. (3) The clear-conversation confirm
is gone. (4) Chat slash commands: `/review`, `/clear`, `/catchup`,
`/summaries`, `/help`, with a `/` hint menu. Help docs (reviewing,
editor) updated. Unit + the review-focus integration test cover the
category wire; DB-backed run verified locally.

Front-end refactor pass (2026-06-17, four-cluster review on develop:
route pages, editor, review feature, shared components/lib), releasing as
v3.13.1 alongside the review-load-parallel bugfix.

Shipped (PRs #464-#472):

- Tier 1 (#464): `format.ts` helpers (pluralSuffix/formatNumber/
  compactCount, tested) replacing inline ternaries and toLocaleString;
  `$lib/api.ts` post()/Result lifted out of scene-actions; the two
  assistant-actions job launchers collapsed into launchJob; dead
  `review-segments.ts` deleted; ReviewAvatar uses roleLabel, EntityCard
  uses EntityBadge.
- Tier 2 component decompositions: EntityEditor -> EntityBadgePicker +
  EntityRelationships (#465); AssistantPanel -> assistant-stream
  (parseSseFrames) + assistant-slash + AssistantProposal (#467);
  SceneEditor -> CoauthorPanel + SelectionMenu (#468); the review reply
  machinery -> ReviewReplyForm (#469).
- Tier 3: paragraphMarkerPlugin shared by alignment/indent (#470);
  RailMarker + isWholeSceneNote in review-ui (#471); shared `.popover`/
  `.menu-item` design-system classes for the action dropdowns (#472,
  ViewMenu normalized - watch its look).
- Bugfix (#466): the author review page loads in one parallel wave.

Route pages decomposed into per-section components, each a thin shell
plus co-located `<X {data} {form} />` section components (forms post to
the page's actions, so the section the result lands in needs no
bookkeeping):

- Account (#473-#475): 2538 -> 268 lines, seven sections (Profile,
  Security, Assistant, Display, Editor, Notifications, Page setup) plus
  a shared FormStatus for the save-feedback line. CSS was already global.
- Admin (#477): 1423 -> 262 lines, eight sections plus a shared
  S3Fields component for the asset/backup connection form.
- Story settings (#478): 1177 -> 178 lines, ten sections; this page had
  scoped CSS, so each section's styles moved into its component (the
  page keeps only the visibility/nav rules); svelte-check confirms no
  orphaned selectors.

SettingsShell (#479): the page-shell / admin-shell / sidebar / main
scaffold that account/admin/settings/universe/insights each reimplemented
now lives in one `SettingsShell` component (topbar + sidebar snippets plus
the main content as children). With this the front-end review is fully
worked through.

Deferred (judged poor value/risk):

- An admin `.status-banner` error variant (the duplicated inline
  danger-banner style) - small, cosmetic, left for whenever admin styling
  is next touched.
- createProseEditor lifecycle helper: only ~8 shared lines per editor;
  routing every `view` access through an accessor is invasive churn in
  the sensitive SceneEditor/ReviewEditor.

Review page Assistant tab (2026-06-18, author's call after the refactor):
make the review page more coherent. (1) The notes panel filter row drops
to just Open and Done (Comments/Edits removed; the type union keeps them,
just no longer surfaced). (2) The right pane gains a Review | Assistant
toggle (author only, when the Assistant tab is enabled), reusing the Write
editor's `AssistantPanel` over the same `/api/assistant/chat` transcript;
the review load now also fetches `listChat` and the route gains
`muteAssistant`/`unmuteAssistant` actions. (3) The "Review with the
Assistant" launcher moves off the left sidebar into the Assistant tab (a
button above the chat, plus the existing `/review` command). Help doc
(reviewing) updated. Reuses already-tested server functions; check, lint,
unit, build green locally.

Universe-aware Assistant (planned 2026-06-23, design note
`scratch/system-design/universe-aware-assistant-plan.md`, branch
`feat/universe-aware-assistant`). Five parts, A first as the foundation; B-E
depend on it. Part A (done): every Assistant layer carries a scope - a story
focus (`{ universeId, storyId, sceneId? }`) or the whole universe
(`{ universeId }`). The retrieval reach is always the universe, so the
per-story Assistant gains cross-story continuity, not just the new universe
surface. Layers: (1) `assistant_chat_messages` gains a nullable `universeId`
with a CHECK that exactly one of story/universe is set (migration 0065),
`chat-history` rekeyed on a `ChatScope`, universe purge cascade; (2)
context assembly branches on scope - a `universe-backbone` tier of the other
stories on the focus path, and a `universe-frame`/`outline`/entities/lore/notes
build on the universe path; (3) the read tools (`get_scene`, `list_scenes`,
`find_appearances`, `search_text`) reach across the universe, write tools
resolve the loaded scene's own story; (4) the gateway derives the universe
reach from the focus story or takes it explicitly; (5) `requireAssistantUniverse`

- scope-based SSE; (6) `searchAll` gains an optional universe filter; (7) the
  shared `AssistantPanel` takes a scope discriminator and both Plan pages get an
  Assistant pill (story Plan shares the Write thread; universe Plan is its own).
  Help doc (planning) updated. lint, check, unit + integration green locally;
  Playwright e2e not run in this environment. Part B (done, branch
  `feat/assistant-write-continuity`): the toolbar Write action now anchors on the
  immediately preceding scene's actual prose, not just its summary, so a draft into
  an empty or short scene continues the prior events and matches its voice. A
  `precedingSceneBody` source returns the previous scene by global position
  (skipping trashed scenes); `assembleContext` gains an opt-in `precedingProse`
  flag that renders a tail excerpt (capped at the recap excerpt length) in the
  scene-local tier; `/api/assistant/coauthor` sets the flag. Ordinary chat turns
  are unchanged. Help doc (editor) updated. lint, check, unit + integration green
  locally; e2e not run here. Parts C + E (done together, branch
  `feat/assistant-slash-commands`): the chat slash commands grow from the original
  five to the planned set, all reusing endpoints/tools that already exist.
  `assistant-slash.ts` gains a `scope` ('story' | 'both') and `args` flag per
  command, `slashArgs` (text after the command), `commandsForScope`, and two menu
  fixes: `slashQuery` returns null once a space is typed (the menu gets out of the
  way while typing arguments) and `matchSlash` filters by scope (the universe Plan
  panel shows only the cross-scope commands). New commands in `AssistantPanel`:
  `/write <brief>` and `/rewrite <how>` POST the buffered co-author endpoint (the
  latter sends the editor selection as a `selection` reference and its reply
  carries a "Replace selection" affordance, backed by new `getSelectionText`/
  `replaceSelection` exports on `SceneEditor`); `/copyedit` kicks the existing
  review flow (scene review when a scene is open, else a whole-story background
  review); `/who <name>` and `/find <query>` are templated tool-enabled chat sends
  that work in both scopes. Selecting an `args` command from the menu leaves
  "/name " in the composer to type into. Help doc (editor) lists the new commands
  and the universe-scope subset. lint, check, unit green locally; e2e not run here
  (the command flows are LLM-backed). Part D (done, branch
  `feat/assistant-continuity-review`): the cross-scene consistency pass runs on
  its own as `/continuity-review`, in both scopes. `scene-review.ts` gains a
  shared `runConsistencyPass` (story or universe scope drives the assembled
  context and the gateway's retrieval reach) and two entry points,
  `reviewStoryContinuity` (one consistency pass over a story's scenes, no
  per-scene copyedit passes) and `reviewUniverseContinuity` (one pass across every
  story in the universe, scenes grouped by story); both skip when fewer than two
  scenes are in scope. A `buildUniverseConsistencyMessage` prompt frames the task
  as cross-story. The background job path is reused: `queueAssistantReview` grows
  an optional `universeId` and a `mode` ('full' | 'continuity'), the review-job
  endpoint queues a continuity job for a story focus or the whole universe, and
  the worker branches on mode/scope, notifying with a continuity-specific message
  (universe notes point at the universe Plan page). Because the write tools
  resolve a scene's own owning story (Part A), a universe-wide contradiction
  stages its thread on the owning story's scene whichever surface launched it.
  Slash command `/continuity-review` is scope 'both'; `AssistantPanel` kicks the
  job through a new `startContinuityReview` action. Help doc (editor) updated.
  lint, check, unit + integration green locally (incl. a new continuity
  integration test covering the story-level single pass, the no-op under two
  scenes, the cross-story framing, and the owning-story thread attribution); e2e
  not run here.

## MCP endpoint, review round 2: app side fixes (2026-11-21)

Part of #1175, branch `fix/mcp-app-side-review-2` on `staging/mcp-endpoint`.
No migration.

- Turning access on. The form was a plain POST and its refusal (a wrong
  password or code) came back under "Apps with access", below the fold on a
  phone. The form is enhanced and keeps what was typed, the refusal has a
  scope of its own (`access`) and shows beside the button. The e2e checks it
  is in view at 390 px wide and at the default size.
- The guided pass after a refused accept. Focus goes to the step's card (the
  pressed button is disabled or replaced, which dropped it to the page). When
  the writer is in Edit and the suggestion was revised under them, the card
  shows "The suggestion now reads" with the new wording above their own,
  which is kept. The refusal line already has `role="alert"` from the sign-in
  branch.
- An authenticator code works once, so turning access on and then making a
  token with the same code is refused. The refusal, a hint under the token
  form's code field and the help article say to wait for the next code.
- Help: a password change disconnects the apps but leaves access on, so only
  the apps need connecting again. The article said to turn access on again.
- "Split here" on a proposal from an app. The shared locate follows a passage
  into a sibling scene, which is right for the Assistant's chain of splits in
  one chat. For a stored proposal the writer was shown one scene, so a
  passage that has moved to another gets the stale sentence and nothing is
  split.

## MCP endpoint, review round 2: endpoint and tools fixes (2026-11-21)

Part of #1175, branch `fix/mcp-tools-review-2` on `staging/mcp-endpoint`,
stacked on the sign-in branch because both add a migration (0101 there, 0102
here: one nullable column, `review_suggestions.revised_at`).

- The staging lock emptied the pool. Round 1 made an app's staging calls for
  one universe take a transaction advisory lock, which is right for the
  checks but means every waiting call sits on a pooled connection: 30 calls
  at once from one grant took all ten, and anything else the server did
  waited for a connection. The calls now queue in memory first
  (`mcp/staging-queue.ts`: a promise chain per key, a count of who is in
  line), so only the call whose turn it is has a connection. Eight may wait;
  a call past that is answered "Another call is still running. Try again."
  without waiting. The advisory lock stays inside the transaction as the
  database's own copy of the rule, and the transaction sets `lock_timeout` to
  two seconds, so if that lock (or any other, such as a row the writer's save
  holds) is not free the call gives up with the same answer. The timeout
  covers the whole transaction on purpose: an app should never wait long on
  the writer either. The test that failed first: 30 calls at once had all ten
  connections busy; now at most two (the call at work and the test's own
  query).
- How long a save can wait on an app. A staging call is one transaction, so
  the scene's revision lock (what a save of that scene waits on) is held from
  the call's first edit to its end. The outer transaction was kept: it is what
  the advisory lock lives in, and it makes a pattern note land whole or not at
  all. Measured instead: a 40-edit pattern note, the largest a call takes,
  held the lock for 0.34 to 0.45 s here; a single edit for a few
  milliseconds. A test asks for the lock over and over during a 40-edit call
  and fails if any wait passes two seconds. What was not done: shortening the
  per-edit work (each edit runs its ceiling check, repeat check and insert in
  turn) so the hold is shorter still. Worth doing if a pattern note ever
  grows past 40 edits.
- One revision for each writer reply. An app could revise its suggestion any
  number of times on one reply, and each revision refuses an accept of the
  earlier wording, so a looping app could keep an accept from landing.
  `revised_at` is set on every revision; an app's revision is refused when
  the writer's last comment is not newer than it.
- A ceiling on drafts: 20 undecided drafts from apps in a universe. The
  drafts table does not say who wrote a draft, so an app's draft is told by
  what it is: ready, with no job (the Assistant's always has one). Counted for
  the writer across apps, so two apps staging at the same moment can pass it
  by one; not worth a lock.
- `nameTaken` ran three queries at once on one transaction client, which the
  driver warns about. They run in turn.

## MCP endpoint, review round 2: sign-in fixes (2026-11-21)

Part of #1175, branch `fix/mcp-sign-in-review-2` on `staging/mcp-endpoint`.
Four lows, nothing above. Migration 0101 adds one nullable column.

- The consent page's code was a bare insert outside the user-row lock, so an
  Allow already in flight could leave a live code behind a password change, a
  reset or a Disconnect. `createAuthorizationCode` is now a transaction that
  holds the user row shared (through `accountUsable`), checks that the session
  that pressed Allow is still live (same user, not revoked, not expired), and
  only then inserts. It returns null when refused and the allow action answers
  403 with a sentence that says to sign in again. The session id is optional
  in the function so the token tests can still make a code without a browser
  session; the route always passes it.
- `revokeToken` (the revoke endpoint) ran outside the lock, so it could answer
  200 while an overlapping refresh left a live pair. It is now a transaction:
  read whose token it is, lock the user row for revocation, revoke the family.
- Lock order inside a family. Two issuers of one account both hold the user
  row shared, so a replayed code and a refresh (or two replays) could take
  token rows in opposite orders. Rather than order the row locks, every path
  that touches a family (`refreshTokens`, `revokeFamily`) first takes a
  transaction-scoped advisory lock on `oauth-family:<id>`, after the user lock
  and any code row and before any token row. One lock is easier to reason
  about than an ordering across three callers, and a family is one
  connection, so nothing useful is serialised away.
- Which host a grant shows. A self-registered client may list this computer
  and one remote host; it was listed and attributed as "localhost" even when
  the code went to the remote host. `oauth_grants.redirect_host` records the
  host of the redirect address the code went to (self-registered clients
  only; a client named by a metadata document is vouched for by where the
  document lives, so it stays null), and `listGrants` and `resolveBearer` use
  it before the client's stored host. Rows from before the column, and
  personal tokens, fall back. Connecting again from the other address updates
  it: the grant is one connection and shows where it was last made from.
- A personal token handed back at the revoke endpoint left its grant live, so
  it stayed in the list and counted toward the limit. `revokeToken` revokes
  the grant too when the token is a personal one.
- The guided pass, found by CI on this branch (`e2e/pattern-pass.spec.ts`,
  the first test). The refresh after a refused accept, added with the app
  side fixes, makes the "text changed" notice appear, so a stale edit showed
  that notice and the refusal line under it, both with the class
  `rv-anchor-lost`. The refusal line has a class of its own now
  (`pp-failure`, same look, `role="alert"`) and is not shown once the passage
  is gone: the notice already says it, and there is no Accept left. The test
  is unchanged.
- Tests. A deterministic one holds the user row shared and checks that
  `revokeToken` waits. The raced ones (revoke against refresh, a replayed code
  against a refresh and a revoke) passed before the fix as well, since the
  window is narrow; they are there as guards, not as reproductions. The test
  events for the consent page now carry a real session row.

## MCP endpoint, review round 1: app side fixes (2026-11-21)

Part of #1175, branch `fix/mcp-app-side-review` on `staging/mcp-endpoint`. No
migration of its own: the indexes this review asked for went into 0100 with
the tools batch.

- Review cards. The name, the host and the "App" chip shared one nowrap line
  that cut from the right, so a long name hid the two parts that say what
  wrote the note. The name and chip are now a flex line where only the name
  gives way (`.rv-who-line`), and the host is a line of its own that wraps
  (`.rv-who-host`). The views still carry one label ("Name (host)", from
  `clientDisplayName`); `appAuthorParts` in `review-ui.ts` takes it apart, so
  the server shape did not change. Avatar initials come from the name alone.
  The Suggestions list and the draft card put the label in wrapping text and
  needed nothing.
- An app's note, and its replies, render through `renderReplyMarkdown`, the
  renderer used for the Assistant: raw HTML escaped, images as their alt
  text, links limited to http, https and mailto. A suggested entry's
  description keeps its line breaks (it stays plain text).
- The personal token form is enhanced. A refusal keeps the name; a new token
  is scrolled into view, focused and selected.
- A split proposal that can no longer be placed tells the writer one
  sentence, whatever the locating code said (its wording is for the program
  that proposed).
- `decideEntityProposal` and `decideSplitProposal` take the universe of the
  page and filter on it in the query that finds the proposal. Before, the
  entity decision committed and was compared afterwards, and the split had no
  check.
- Suggestions uses `FormStatus`; the scene link in a split row is underlined
  in the body colour like the other prose links (`.list-title a`).
- Help: an app's notes show its address under its name, a personal token's
  show "personal token"; suggested edits, suggested entries, proposed splits
  and undecided drafts are not exported (review comment threads are, through
  `export-reviews.ts`, an app's included).
- Not done here, to be filed: focus and an announcement after each decision
  on the Suggestions page, disconnecting an app while the admin switch is
  off, and a sign elsewhere that something is waiting.

## MCP endpoint, review round 1: endpoint and tools fixes (2026-11-21)

Part of #1175, branch `fix/mcp-tools-review` on `staging/mcp-endpoint`,
migration 0100 (indexes only).

- Writer trust (H1). `update_suggestion` could change a pending edit's text
  at any moment, and Accept sent only the id, so the writer could apply text
  they never saw. The same held for the in-app Assistant's revise. Now every
  accept form sends `seen`, a SHA-256 of the replacement as the page showed it
  (`suggestionStamp`, carried on `SuggestionView.stamp`), and
  `decideSuggestion` reads the suggestion `for update` inside its transaction,
  after the scene row, compares, and applies the text it read there. It used
  to read the replacement before the transaction; a test that races an accept
  with a revision showed unseen text landing. A stamp was picked over a
  revised-at column because it needs no migration and is exact: a revision
  back to the same text is the same proposal. `textHash` was not used; it is
  not collision resistant and the other side is a program. The page actions
  refuse an accept without `seen`; the function takes it as optional for the
  callers that are not a page (tests, the bulk path passes a map). The only
  accept paths are the three forms on the review page (card, guided pass,
  "Decide together"); nothing in the editor or the chat accepts a suggestion.
  On a refusal the card and the list reload.
- Over MCP `update_suggestion` also needs the writer to have written last in
  the edit's discussion. Everywhere, a revision must change something and
  must not repeat another pending edit of the same author
  (`updateAssistantSuggestion`, now one transaction with the row locked).
- Errors (M1). The write cases of the dispatcher's switch were returned
  without `await`, so a throw skipped its catch and reached the caller: over
  MCP the SDK answered with the error's message, which for a query is the
  statement and its parameters. The same on main sent the throw up the in-app
  tool loop. All cases are awaited; a database error is never quoted, to the
  model or the app; `callMcpTool` has a catch of its own around everything
  after the rate limit; the log line carries the tool and the error code only;
  a null character in any string argument is refused before any query.
- Trashed scenes (M2). `reachableStory` and `isOwnNote` join the scene and
  require it live, so `reply_in_thread`, `update_suggestion`,
  `get_review_note` and a `suggest_edit` linked by `patternNoteId` or
  `followsSuggestionId` all miss on one.
- Whose thread (M3). `reply_in_thread` took any thread of the story. It now
  takes a note the app opened or the discussion under its own edit
  (`isOwnThread`). A thread the writer opened is refused too: the earlier
  test that replied in one was a convenience of the test, not a rule; an app
  has no tool that would tell it such a thread's id.
- Calls sent together (M4). The duplicate refusals and ceilings were check
  then insert. An app's staging calls now take
  `pg_advisory_xact_lock(hashtext('mcp-staging:<client>:<universe>'))` in the
  dispatcher and run inside that transaction. Universe and client was chosen
  over scene and client so one lock covers the scene tools and
  `suggest_entity` alike; at 30 staging calls a minute nothing is lost. The
  handlers that catch a unique violation insert inside a transaction of
  their own (a savepoint here), so the refusal does not abort the call.
  Unique indexes back the one-row rules for callers outside that lock (the
  Assistant and an app suggesting the same name). The follow-up index covers
  apps only: the Assistant's rows on main may already hold repeats, and its
  re-read runs one at a time. The turn check of `reply_in_thread` moved under
  `addComment`'s thread lock.
- `update_suggestion` gives "No suggestion with that id." for anything that
  is not the app's own pending suggestion (L2). `stageAppDraft` no longer
  discards a failed draft of the writer's on that scene (L3).
- The indexes on `client_id` and `scene_id` asked for in the app-side review
  (L4) are in the same migration.
- Not done here, to be filed: `get_review_note` re-anchoring the whole story
  per call, and blocked calls counting against the grant's rate bucket.

## MCP endpoint, review round 1: sign-in fixes (2026-11-21)

Part of #1175, branch `fix/mcp-sign-in-review` on `staging/mcp-endpoint`. No
migration.

- A self-registered client could list redirect URIs on several hosts, and the
  consent page named the first one, not the one the answer went to. A
  registration and a metadata document are now refused when their redirect
  URIs name more than one remote host. Loopback addresses may sit beside the
  one remote host, because desktop clients register both (a first cut refused
  that mix and was relaxed before merge). The consent page names the host of
  the redirect URI in use, which also covers rows registered before the rule:
  a loopback redirect shows the loopback name and "The app runs on this
  computer", never the remote host. A registered client that lists a loopback
  address is stored under it, so Connected apps does not show a remote host a
  local program merely listed.
- `client_name` loses format characters (`\p{Cf}`: bidi overrides, zero-width
  marks) as well as control characters.
- Turning the account switch on asks for the password and, with two-factor on,
  the code, through one `confirmIdentity` helper shared with `createToken`
  (same throttle). Turning it off asks for nothing. While off, the section
  shows a small form instead of the toggle.
- "Sign out other sessions" does not revoke grants or tokens. It is about
  browsers; an app is disconnected from its own list. Left as is on purpose.
- Revocation against issuing: `exchangeCode`, `refreshTokens` and
  `createPersonalToken` take the user row `for share` before anything else,
  and `revokeAllGrants` and `revokeGrant` take it `for update`. The issuers
  read the owner's id by hash without a lock first, then lock the user, then
  the code or token row, so the order is always user first and there is no
  cycle with a prior live grant. Tests race the two forty and twenty times.
- `revokeGrant` spends that user and client's unspent codes, so a consent
  given just before Disconnect cannot be exchanged after it.
- A faulty authorize request for a known client and redirect used to be
  answered by a redirect to the client with the error. It now shows "This
  request cannot be answered" with a "Return to <host>" link carrying the same
  error; the allow and deny actions answer 400 on such a request. The writer's
  own Deny still redirects.
- Suspending an account revokes its grants and tokens in the same transaction.
- Looked at and left: a DELETE to `/api/mcp` with no Origin and no content
  type is refused by the hook's cross-site form check with a plain 403 in
  production, before the route, where the transport would have said 405. The
  endpoint issues no session id, so a client following the spec has no reason
  to send one.
- Not done here, to be filed: a grace window for a refresh token used twice,
  a throttle and negative cache on metadata document fetches, and per-address
  limits for hosted clients.

## MCP endpoint, lane 9: documentation (2026-11-21)

Part of #1175, branch `docs/mcp-endpoint` on `staging/mcp-endpoint`. No code
beyond the help index entry.

- New help article `connecting-apps` ("Connecting an app"), written for
  someone who has never connected anything: what it is, the steps, what an
  app may do, where to find what it left, disconnecting, and what to do when
  it does not connect. The Connected apps section of `account` stays as the
  reference and links to it.
- `docs/SELF-HOSTING.md` has a "Connected apps (MCP)" section: claude.ai and
  Claude Desktop connect from Anthropic's servers, so the instance must be
  reachable over public HTTPS; `ORIGIN` must be the public URL; which paths a
  proxy must pass. The in-app self-hosting article says the same in plain
  words.
- `assistant.md`: the status header now says the toolbox is also served over
  MCP. The exception list was written lane by lane and is complete as of
  lane 7. The old note that the Assistant uses "no MCP" is in the Phase 9
  entry of this file, further down; it describes how the Assistant's own
  model gets its tools (in-process function calling), which is still true,
  so it stays as written.
- Not in this round, by decision: the pass card (MCP Apps), a
  `decide_suggestion` tool and the `apply` permission.
- Left for later, found while building: a count of waiting suggestions
  outside the universe's settings, and a notification when an app stages
  something.
- The help link in the top bar opens the new article while Connected apps is
  the open section of the account page.

## MCP endpoint, lane 8: personal access tokens (2026-11-21)

Part of #1175, branch `feat/mcp-personal-tokens` on `staging/mcp-endpoint`.
No migration: the two `kind` columns are plain text and gained a value each.

- A personal token is a grant on a client row of kind `personal`, with one
  `api_tokens` row of kind `personal`. The alternative was a token row with
  no grant and no client, carrying its own name and permissions. That would
  have needed new columns and a second path through everything keyed on the
  client: the `client_id` on review rows and proposals, the "only your own
  note" rules, the waiting-note ceilings, the rate limits and the log line.
  Giving the token a client row of its own made all of that apply unchanged,
  and `resolveBearer` only had to accept one more token kind.
- The OAuth side cannot reach a `personal` client: `findClient` returns only
  `dcr` rows for a non-URL id, the row has no redirect addresses, and a
  personal token is not a refresh token. `resolveBearer` also refuses a token
  whose kind and client kind disagree.
- Its host is the fixed text `personal token`, which no registered app can
  have as a host, so "Name (personal token)" cannot be imitated.
- Making one re-checks the password under the shared re-auth throttle, and
  the TOTP code when two-factor is on. The secret is in the action's answer
  only; the page data never holds it.
- Revocation needed no new code: `revokeGrant` (one token, owner-scoped) and
  `revokeAllGrants` (switch off, password change, reset, scheduled deletion)
  already cover grants and tokens of every kind.
- The clean-up revokes the grant of a personal token whose row has expired
  and been deleted, so it leaves the list; until then the list says Expired.
- Tests: the lifecycle and the account actions in `mcp-oauth.test.ts`; in
  `mcp-endpoint.test.ts` a table runs every tool with a personal token
  against another writer's universe and ids and the writer's own muted and
  trashed scenes.
- Also in this branch: the prompt wording fixes (the shared builders take the
  source of the world details; a review of an untitled scene names it by id;
  the rewrite prompt reads as a rewrite).

## MCP endpoint, lane 7: proposals and app drafts (2026-11-21)

Part of #1175, branch `feat/mcp-proposals` on `staging/mcp-endpoint`.
Migration `0099_mcp-proposals` (two new tables, nothing rewritten).

- `suggest_entity` on both surfaces, `propose_scene_split` now offered over
  MCP, and `stage_scene_draft` over MCP only. All three need `suggest`.
- New tables rather than a reuse of `entity_suggestions`: that table hangs a
  field suggestion (alias, detail, summary) off an entry that exists, with a
  target id and a job. A proposal for a new entry has no target, so it got its
  own table and its own list. The accept path inserts the row the same way
  the Plan sidebar's create does and queues the universe mention scan.
- The list lives in the universe's settings as a Suggestions section with a
  count in its link, built from the existing list primitives
  (`UniverseSuggestions.svelte`). The tool results give the app the link.
- The split store is used by apps only. Sharing it with the in-app card was
  considered and left: the card already confirms through the split endpoint
  with the text re-located at confirm time, and moving it would change a flow
  that works for no gain. Confirm from the store reuses `locateSplitInStory`
  and `splitScene`. The proposal is claimed before the split and put back if
  the split is refused, so two confirms cannot both split.
- App drafts needed no schema change. The row is an ordinary `ready`
  `assistant_drafts` row with the app's label in `note`, which the draft card
  already shows, and the unique index gives the one-undecided-draft rule. The
  writer's fill, add as new scene, and discard are untouched.
- The `write`, `draft` and `draft-chapter` prompts now end by staging with
  `stage_scene_draft` for a connection that may suggest.
- Deferred: a count of waiting suggestions outside the universe's settings
  (the Plan sidebar or the library), and a notification when an app stages
  something.

## MCP endpoint, lane 6: prompts (2026-11-21)

Part of #1175, branch `feat/mcp-prompts` on `staging/mcp-endpoint`. No
migration.

- Eleven MCP prompts, one per Assistant flow (`src/lib/server/mcp/prompts.ts`),
  registered on the per-request server next to the tools.
- One source for the instruction text. `review` and `copyedit` call
  `buildReviewMessage`; `write` and `rewrite` call `buildCoauthorMessage`;
  `draft` and `draft-chapter` call `buildSceneDraftMessage`; `catchup` calls
  `buildRecapMessage`. For the two staged passes the shared sentences in
  `prompts/review.ts` became constants, used both by the staged builders and
  by two new briefs for an agent that runs the pass itself. The `/who` and
  `/find` asks moved out of the chat panel into `assistant-slash.ts`. Unit
  tests assert each prompt contains its builder's output, so a change to the
  Assistant's instruction changes the prompt with it.
- Prompts do not read the database. The alternative was to look up the scene
  to put its title in the prompt and refuse a foreign id there; that would
  have added a second place where ownership is decided. A prompt for another
  writer's ids is the same text around those ids and nothing else (tested);
  the tools refuse the ids.
- The review prompt therefore says `Review the scene "this scene" (id: ...)`,
  the builder's wording for an untitled scene.
- Arguments are text. Ids must look like ids, free text is capped (the brief
  at the draft brief's cap), `focus` takes the review categories, `words` is
  clamped as the draft form clamps it. A bad argument is a protocol error
  that names it.
- Review and copyedit are per scene. A chapter or a story is the agent
  running the prompt scene by scene, where Codex would queue a background run.
- The pattern caps moved to `prompts/review.ts` (re-exported from
  `pattern-pass.ts`), so the prompts module does not import the gateway.

## MCP endpoint, lane 5: the guided pass and reading notes back (2026-11-21)

Part of #1175, branch `feat/mcp-guided-pass` on `staging/mcp-endpoint`. No
migration.

- Two read tools in the shared registry, `list_review_notes` and
  `get_review_note`, backed by `listOwnNotes` and `getOwnNote` in `review.ts`.
  "Own" is the caller: the Assistant in the app, the connected client over
  MCP (`writtenBy`). They are in the Assistant's default set, so it can check
  what became of an earlier note when asked.
- Replies are filtered to the writer's and the caller's own. A guest
  reviewer's comment in the same thread is not shown, and neither is another
  app's or (to an app) the Assistant's. The "writer wrote last" flag is worked
  out over the same filtered list, so a guest's aside after the writer's
  question does not hide the question.
- `get_review_note` takes a note id or an edit id, since a loose
  `suggest_edit` has a discussion too and no note to hang it on. An edit
  someone else linked to the note (the Assistant's follow-up on an app's
  note) is shown with `yours: false`.
- The edits come from `listSuggestions` for the story, filtered, so the
  anchors (and so "the paragraph as it now stands") are the review page's own.
  That reads every suggestion of the story for one note; the review page pays
  the same on each load, so it was not worth a second anchoring path.
- A note on a scene in the trash is not found; one in a muted or trashed
  story is not found either (the same `reachableStory` check as lane 4).
- `suggest_edit` over MCP: `patternNoteId` must be a note the app opened;
  `followsSuggestionId` must be an accepted edit in such a note, in the same
  scene, and the edit must fall inside `paragraphWindow(..., 1)` around where
  the accepted text now sits. One follow-up per accepted edit per app,
  counted whatever became of it, so a rejected follow-up is not retried in a
  loop. The window size is one constant (`FOLLOW_UP_NEIGHBOURS`) shared with
  the Assistant's re-read.
- The re-read (`pattern-reread.ts`) accepted only a note whose first Assistant
  comment existed; it now takes the thread's opening comment and requires the
  Assistant or an app to have written it. Its follow-up stays the Assistant's.
- `?pass=<note id>` on the story review page starts the pass once, when the
  page first loads, if the note is there and has pending edits. The parameter
  is left in the address, so a reload opens the pass again.
- Not done, on purpose: the in-app Assistant does not answer in an app's
  thread. The app answers for itself (it reads the writer's reply with
  `get_review_note`), so there is one voice per note. This replaces the line
  in the lane 4 notes that deferred it here.

## MCP endpoint, lane 4: staging tools and the app as author (2026-11-21)

Part of #1175, branch `feat/mcp-staging` on `staging/mcp-endpoint`,
migration 0098.

- A fourth review author. `review_comments` and `review_suggestions` gain
  `client_id` (set null when the client row goes), `client_name` and
  `client_host`. The name and host are copied at staging time and
  `client_host` being set is what marks the row as an app's, so attribution
  does not depend on the client row, which the worker prunes. One function
  (`clientAuthorName` in `review.ts`, over `clientDisplayName`) turns the two
  into the label.
- The Assistant's own-write rules were generalised to "a program's own
  writes" (`MachineAuthor`, `writtenBy`): the duplicate checks, the retried
  pattern note, and the revise-own-pending-suggestion rule each compare on
  `assistant = true` or on `client_id`. Two apps, or an app and the
  Assistant, never dedupe against or revise each other.
- Like the Assistant's, an app's notes cannot be retracted by anyone; the
  writer resolves, rejects or clears them.
- `reply_in_thread` and `update_suggestion` take the target id as an
  argument over MCP. The check (`reachableStory` in the dispatcher) requires
  the story to be the writer's, live, unmuted and in the named universe;
  anything else is "No thread with that id." or "No suggestion with that
  id.".
- Three guards against a looping client: the staging rate limit, the
  ceiling of 100 waiting notes per scene and app, and the rule that an app
  does not reply to its own latest reply. The last one was not in the issue;
  it is the cheapest way to stop a reply loop, which the ceiling does not
  count.
- `leave_comment` tells an app the new thread's id so it can reply there
  later. The in-app result is unchanged.
- The review UI shows an app's notes with an "App" role chip and plain-text
  bodies (the Assistant's are rendered as markdown; an app's are treated
  like a reviewer's).
- Deferred to lane 5: "Work through this" on an app's pattern note and the
  re-read after an accept. No notification is sent for an app's note.

## MCP endpoint, lane 3: the endpoint and the read tools (2026-11-21)

Part of #1175, branch `feat/mcp-endpoint` on `staging/mcp-endpoint`, no
migration.

- `/api/mcp` on `@modelcontextprotocol/server` 2.x, stateless, with the
  SDK's fallback for 2025-era clients left on. One handler for the process;
  the route resolves the bearer token and passes the connection in, and the
  SDK builds a server per request from it.
- The tools are the Assistant's own. `list_universes` and `list_stories`
  are in the shared registry marked `external`, never offered in the app and
  refused by the dispatcher there. `mcp/tools.ts` adds the required
  `universeId` argument and runs `ownsUniverse` on every call.
- "Not found" is uniform. Ids that are not uuids are a miss in the
  dispatcher instead of a query error, and a handler that throws now flags
  the outcome so the endpoint answers "The tool failed" and keeps the error
  text in the log, not in the reply to an outside app.
- `get_entity` and `find_appearances` now require the entity to be in the
  context's universe. The check is in the dispatcher, so the in-app
  Assistant gets it too; before, an id from another of the writer's own
  universes resolved.
- `get_scene` is capped at 120,000 characters over MCP (the in-app cap
  stays at 200,000), and any result at 140,000, because clients cut a
  result at about 150,000 characters.
- Origin: a request whose `Origin` is not this site's is refused. That
  rules out a browser-based client on another site until someone needs one;
  the place to allow it is the check in the route.
- Rate limits are in-memory like the others, so the single-replica note in
  SELF-HOSTING applies. Numbers are in `mcp/constants.ts`.
- Deferred: the staging tools and their author kind (lane 4), prompts,
  reading a long scene in parts.

## MCP endpoint, lane 2: the OAuth server (2026-11-21)

Part of #1175, branch `feat/mcp-oauth` on `staging/mcp-endpoint`, migration
0097. The authorization server an outside app signs a writer in through; the
MCP endpoint itself is the next lane.

- Both ways for a client to name itself are supported: self-registration
  (`/oauth/register`) and a metadata document at an https URL. The metadata
  advertises `client_id_metadata_document_supported` and the `none` token
  method, which is what makes a client that supports documents use one. A
  document is fetched through the egress guard (private addresses always
  blocked), capped in size and time, cached for a day, and a stale copy is
  kept when a re-fetch fails.
- Clients are public only. Redirect addresses are https, or http on
  localhost, 127.0.0.1 or [::1], where the port is ignored when matching.
  Custom URL schemes are refused; a desktop app is expected to use loopback.
- The app name is stored with the host Codex checked, and
  `clientDisplayName` in `src/lib/mcp-access.ts` is the one place that decides
  how the two are shown.
- Lifetimes and limits are in `src/lib/server/mcp/constants.ts`: code 1
  minute, access 1 hour, refresh 30 days sliding. A refresh token is replaced
  on each use and a second use of a spent one revokes its family, with no
  grace window. A replayed code revokes the tokens it bought.
- Permissions live on the grant, not the token. `apply` is in the stored
  vocabulary but not offered (`GRANTABLE_PERMISSIONS`), since nothing acts on
  it yet.
- Turning the account switch off revokes every grant instead of pausing
  them, so switching it back on never revives a connection the writer may
  have forgotten.
- SvelteKit's cross-site form check rejects a form post with no Origin
  before any hook runs and has no per-route exception, which would block the
  token endpoint. It is switched off (`csrf.trustedOrigins: ['*']`) and the
  same rule runs first thing in `hooks.server.ts` with `/oauth/token` and
  `/oauth/revoke` left out. Those paths, the register endpoint and the
  discovery documents skip the session cookie entirely.
- The page policy has `form-action 'self'`, which some browsers apply to a
  redirect that follows a form, so the consent actions return the address
  and the page navigates to it.
- The sign-in return is a short-lived cookie set by the hook when it sends a
  signed-out visitor to `/login`, accepted only for `/oauth/authorize`, and
  consumed by password, two-factor, passkey and emailed-link sign-in.
- Deferred: the MCP route and its Origin check (lane 3), any use of
  `suggest` (lane 4), and attribution of an app's suggestions, which has to
  survive the client row being pruned.

## Scene drafting, review round 6 (2026-11-21)

Small fixes from the sixth review of #1168, branch
`fix/scene-draft-review-6` on `staging/scene-drafting`.

- A brief kept behind a draft was overwritten when the writer asked again
  without a reload: the form opened from the scene's defaults and the
  remembering effect stored those. The form now restores what was stored
  first.
- "The writer has seen the refusal" was inferred from a card being attached
  or from the stranded text being looked up. It is now set by the card
  while the changed or gone view is on screen and cleared when it is not
  (`conflictShown`), so the leave prompt is silent only then. A refused
  edit stays unsaved in the queue's eyes and is not sent again.
- Reply-size stripping skips `response_format` whole and knows a few more
  names. `hasWaitingDrafts` had no caller left and was removed.

## Scene drafting, review round 5 (2026-11-21)

Fixes from the fifth reviews of #1168, branch `fix/scene-draft-review-5` on
`staging/scene-drafting`. All of it is one situation seen from several
sides: a draft decided in another window while this one holds unsaved text.

- A refused save with no card on screen left the text held where nothing
  showed it. Held edits now know their scene, and a card that finds the
  scene's draft gone or replaced asks for text stranded there
  (`strandedDraftText`) and shows the "already kept or discarded" view with
  it. The edit is dropped when the writer closes that view, not when it is
  shown, so a pane switch in between does not lose it.
- With the card on screen, a refused save now reads the draft again and
  goes to the same view when it is no longer waiting. "Changed in another
  window" is left for a real text conflict. The server's refusal says which
  it was (decided, or never written), and "Reload the page" is gone, since
  reloading dropped the typing.
- Once a refusal has been shown, the edit is not sent again and the page
  does not ask before it is left.
- A clean copy follows a fresh read only when this window has never sent
  a save for the draft. Adopting whenever nothing is unanswered was tried
  on paper and dropped: a read sent before this window's last save landed
  can come back after it with older text, which round 3 had fixed.
- Drafts meter spend with no cap set (`meterUncapped`), so a cap set or
  raised mid-run is held against the real total; other jobs meter as
  before.

## Scene drafting, review round 4 (2026-11-21)

Fixes from the fourth reviews of #1168, branch `fix/scene-draft-review-4` on
`staging/scene-drafting`.

- Draft saves now use the scene save's rule instead of their own. Rounds 2
  and 3 had grown an md5 `base`, a `sent` text for the page-hide save, a
  list of versions saved over, and still called a lost answer followed by
  more typing a change in another window. The request now carries the
  hashes of every text sent and not answered plus the last acknowledged
  one, and Fill and Add take the same list. The scene saver was not reused
  as it stands: it is built around the scene PUT (title, markers, its own
  conflict body, the editor's callbacks). Its hash bookkeeping was lifted
  into `save-bases.ts` and both use it. A save is not skipped while a text
  is unanswered, which also covers undoing back to the old text.
- Not fixed, recorded in `assistant.md`: a page-hide save that puts the
  base text back and overtakes an older save lets the older one land last.
  The scene save has the same limit; telling them apart needs a counter,
  not a content hash.
- A draft decided in another window was a dead end on the card. The card
  now reads the draft again on a 404 or 409 and before showing a ready one,
  and closes with a plain line; unsaved text is shown read-only until the
  writer closes it, not thrown away.
- An empty length box made the whole stored form invalid (Svelte binds an
  empty number input as null), which dropped a half-typed brief. Fields are
  now read one at a time.
- The waiting list polled by re-running an effect on the list prop, which
  the page's own live refresh kept restarting before the wait ended, so it
  never fired. The effect now hangs off a derived boolean.
- Server: the discard of failed rows after the insert leaves the new rows
  alone (a job can fail before the request returns); `n`, `best_of` and
  nested reply limits are stripped on bounded requests; the capped note
  gives figures instead of "reached the cap at about $0.00"; a paused
  reply's resume asks `mayResend`.

## Scene drafting, review round 3 (2026-11-20)

Fixes from the third reviews of #1168, branch `fix/scene-draft-review-3` on
`staging/scene-drafting`.

- Asking again for a scene whose draft had a saved edit put the first-read
  text back: the card's cached copy was shown again and the clean edit
  adopted it. Three changes, any one of which closes it: the request only
  reveals a ready draft that is already in the box; the card's copy follows
  each save; and the edit state keeps the versions it has saved over and
  never adopts one of them (which also covers a slow read that lands after
  a save).
- A retried save whose first answer was lost was refused as changed
  elsewhere. Stored text equal to the text sent is success. For the save
  made as the page is left while another is still out, chaining was tried
  on paper and dropped: the page may be gone before the first answer, so
  the second would never be sent. It goes out at once and names the other
  save's text (`sent`); the server takes it over either. An md5 of that text
  would have been tidier, but the browser has no md5.
- The off-state tab lists the story's waiting drafts by scene, since the
  card only shows for the open scene. Pending and running drafts count, so
  the tab is there to stop one.
- Page-hide and leave-warning handling moved from the card into
  `draft-edits.ts`, registered once, so a released edit is covered. Clean
  released edits are freed after a minute, not at once, so a late read
  still meets the versions it must not take.
- The cap could be passed by a resend: the gateway sent a billed, failed
  attempt again without looking at the meter, and the job only stopped once
  spend was already at the cap. Drafts now ask before every send whether
  spend plus this request at its limit fits. It is a hook on the request
  (`mayResend`) and a check in the draft job, not a gateway-wide rule: other
  roles are unchanged and have the same gap, to be filed.
- Round 2 made "Longest reply" unable to raise a non-thinking draft's limit,
  which left the cut-off notes giving advice that did nothing. They are now
  worded by what set the limit, and the headroom grows with the length.
- A new request inserts its rows before it discards the failed ones it
  replaces, and only after the job is queued: scene row before draft row,
  the order a scene delete takes them, and the failure note survives a
  request that does not go through.
- `base` is required on the endpoint; the library functions still take it
  as optional for callers that hold the row themselves (tests).

## Scene drafting, review round 2 (2026-11-20)

Fixes from the second pair of reviews of #1168, branch
`fix/scene-draft-review-2` on `staging/scene-drafting`.

- The cap figure could still be lower than the limit sent: a non-thinking
  role with a "Longest reply" above the draft's need was sent that setting
  and counted at the words asked for. A draft request is now `boundedReply`:
  without thinking, the setting can lower the limit but not raise it, and
  the estimate counts the limit sent for every role ("up to", always). The
  flat persona figure and chars/4 counting in the prompt side were left.
- An empty reply was thrown and retried, paying three times for the same
  nothing. It is settled as failed with a note and the job ends; in a
  chapter run the run ends at that scene.
- A chapter scene was told it followed the run's previous draft even when
  that scene was not adjacent, or the draft was already kept (then the
  context held it twice). Carried only for the adjacent, undecided one. A
  scene trashed mid-run still breaks the chain, as before.
- Two windows on one draft: saves and the keeping choices send the md5 of
  the text last seen, compared in the statement that writes. Chosen over a
  version column to avoid a migration.
- Client: edits are held in module state by draft id, so a slow save from
  an unmounted card cannot be overtaken by the remount's read, and are
  flushed on pagehide (keepalive when the body fits, else the page asks
  before leaving). Brief forms moved from module state to `sessionStorage`.
  A start is ignored for 700 ms after the estimate shows; a fixed delay was
  chosen over a second confirm step to keep the form at two presses.
- The slash menu's ranked matcher is kept, but a one-letter query uses menu
  order as on main. Against main, the only first-row change comes from the
  new `/draft` commands and `/write` being relabelled.
- Deferred, to file: discarding the scene being written in a chapter run
  does not stop its request; the flat persona figure and chars/4 counting
  in the estimate.

## Scene drafting, review round 1 (2026-11-20)

Fixes from two reviews of #1168 steps 1 and 2, branch
`fix/scene-draft-review-1` on `staging/scene-drafting`.

- The estimate was lower than the charge when the Write role may think: the
  gateway raises the reply limit to the thinking default, and the estimate
  counted only the scene's words. `requestReplyLimit` in the gateway is now
  the one place the limit sent is worked out; the estimate calls it and
  counts the whole limit as an "up to" figure when the model may think.
- Main gained its own migration 0095 (#1324). Main was merged in, the
  branch's 0095 dropped and the table regenerated as 0096, with
  `chapter_id` now `ON DELETE SET NULL` and indexes on `job_id` and
  `chapter_id`. A run whose chapter is deleted carries on: the scenes are
  still in the story, and `position` (not `chapter_id`) marks a run's rows.
- A draft's row is written with a job id made up front, which the queue then
  uses, so there is no window where a queued job has a row without its id. A
  row whose job the queue has never seen is settled as failed after a
  minute's grace (`QUEUE_GRACE_MS`).
- Reading, editing and deciding a staged draft need only its owner. The
  panel shows the draft cards on a muted story, and the story page keeps the
  Assistant tab for an account with the Assistant off while drafts wait.
- Edits to a ready draft are saved to its row (PATCH, a moment after typing
  stops, on blur, and when the card goes away). A brief form left open is
  kept in module state by scene or chapter for the page's life; it is not
  stored, so a reload starts it fresh.
- The cards tell "no draft" from "could not read" and retry the latter,
  poll with the activity center's pacing (`pollPause`: slower after five
  minutes, paused in a hidden tab), keep keyboard focus between steps (one
  button for "Check the cost" and "Draft the scene", not disabled while it
  works) and return it to the chat box on close.
- A link (`draft=1`, `draftChapter=`) is acted on once and then taken off
  the address. A chapter link shows the drafts waiting instead of a form.
- `/draft` no longer runs `/write`: the matcher ranks the command named
  exactly, then names the query starts, then label words; `/write` is
  labelled "Write a passage". The drafting commands are not listed where a
  draft cannot be kept (Review, story Plan, an earlier version in Write).
- The cards share `.assist-card` rules in `primitives.css` with the split
  proposal, use `.field-hint` and `FormStatus`, and share the cost sentences
  with the review confirm step (`cost-notes.ts`, `DraftCostNote.svelte`).

Left as they are, to be filed: the estimate and the run each assemble the
context once per scene of a chapter, and the chapter brief lives only in the
job's data. Staged drafts are not in the account or story export.

## Chapter drafts (2026-11-20)

#1168 step 2, branch `feat/chapter-draft` on `staging/scene-drafting`, on top
of the scene drafts below. One job drafts the ticked scenes of a chapter in
order, each into its own `assistant_drafts` row, and each row is then an
ordinary scene draft: Fill, Add as a new scene, Discard, in that scene's card.
No migration: `chapter_id` and `position` were put on the table for this, and
the rows of a run share its `job_id`, so there is no run table.

Choices made while building:

- The command is `/draft-chapter`, not `/draft` with a mode. Write has no
  chapter focus (only a scene is ever open), so `/draft` could only have
  guessed. `/draft-chapter` drafts the chapter the open scene is in, and the
  chapter's menu names the chapter directly. With no scene open the command
  says to open one or use the chapter's menu.
- A chapter with no scenes is refused, with a message to add a scene for each
  part first. The run never creates scenes; a drafted scene only reaches the
  story through the two accept actions.
- The form has one brief for the chapter and a ticked list of scenes with a
  line each. A scene may leave its line empty when the chapter brief is
  given. One length and one point of view apply to every scene. Scenes with
  text start unticked (their draft could only be added as a new scene).
- A scene with an undecided draft is left out of the run and the estimate,
  and the card says how many were. When every ticked scene has one, the
  request is refused.
- Continuity: each request carries the closing 6000 characters of the scene
  drafted just before it, and the writer's line for the next scene in place
  of that scene's summary. After a scene that was skipped or gone, nothing is
  carried, so the next scene is not told to follow a draft two back.
- The run ends at a scene boundary on Stop, the spend cap, or the Assistant
  going off for the story or the account. Drafts already written stay ready
  and the rows not reached are discarded, so the scenes are free to be asked
  for again. A Stop in the middle of a request drops that scene whole.
- A scene deleted or trashed before its turn is left out and the run goes on.
- A failed request is retried with the job, and the retry reads the rows
  again, so it carries on from the scene that failed. When no retry follows,
  that row is marked failed with the reason (its scene's card offers Try
  again, as a single draft) and the rest are discarded.
- Discarding one scene's draft while the run is under way does not stop the
  job; the job passes over it. Stopping the whole run is the card's Stop.
- Progress is counted from the rows (settled out of asked for), so the
  job-status poll needs no store of its own.
- The notice links to the story with `draftChapter=<id>`, which opens the
  panel on the chapter's list of drafts.

Deferred: a length or point of view per scene, creating the chapter's scenes
from an outline, and accepting every drafted scene in one action.

Tests: `tests/integration/chapter-drafts.test.ts` (the gates, the summed
estimate and cap, cap stop and Stop at a boundary, mute and off mid-run, a
scene trashed or deleted mid-run, retry, per-scene accept and discard,
ownership), draft cases in the worker handler, running jobs and queue policy
tests, prompt unit tests, and `e2e/chapter-draft.spec.ts`.

## Scene drafts (2026-11-20)

#1168 step 1, branch `feat/scene-draft` on `staging/scene-drafting`. The
Assistant writes one whole scene from the writer's brief. Decided by the
owner beforehand: no setting for it, only ever started by the writer
(`/draft`, or "Draft this scene..." on the scene's menu), never over the
writer's text, and counted before it runs.

It is a background job on its own queue (`assistant-draft`) and not a
stream, because a scene on a local model takes minutes; the job shape is the
details read's (#1170). The text is staged in a new table, `assistant_drafts`
(migration 0096, renumbered in review round 1), and the scene is only written when the writer chooses in
the panel card (`AssistantDraft.svelte`). "Fill this scene" takes the scene's
row lock, refuses when the stored body has any prose, and saves through
`saveSceneBody`, so it is a revision. "Add as a new scene after this one"
reuses `lockStoryScene` and `makeRoomAfter` from the split code (now
exported). Lock order is scenes first, then the draft row.

Choices made while building, none of them settled by the issue:

- One undecided draft per writer and scene (a partial unique index). Asking
  again while one waits shows it instead.
- The reply limit is words times 1.4 plus 400 tokens, held to
  `MAX_REPLY_TOKENS` and half the context window. The app does not know a
  model's output limit, only its window. A "Longest reply" set for Write in
  its Tune window still wins in the gateway, as it does everywhere; the
  estimate tells the writer when that would stop the scene early rather
  than overriding their setting.
- A reply cut off at the limit is kept as a ready draft with a note. A stop
  discards the draft (the worker only notices a cancel at its heartbeat, so
  reading a draft whose job is gone settles the row: stopped ones are
  discarded, others marked failed).
- An estimate over the spend cap is a 409 from the request too, not only a
  disabled button.
- A scene that already has prose can still be drafted: the prompt is told to
  carry on from it, and only "Add as a new scene" is offered.
- The writer's edits to a ready draft live in the card until it is kept;
  they are not saved back to the row.
- Keeping or discarding a draft is not gated by the mute, so muting a story
  never strands a draft. Reading one and asking for one are gated.
- A new notification kind, `assistant_draft`. Its link, and the Background
  jobs row, open the scene with `draft=1`, which opens the panel on the draft.
- The neighbouring summaries the context reads can be stale (#1321); the two
  places this code reads a summary itself use `usableSceneSummary`.

Deferred: chapter drafts (step 2; `chapter_id` and `position` are on the
table for it), streaming the draft into the card as it is written, and a
replace action (ruled out).

Tests: unit for the prompt and the length maths; integration for the gates,
the cap, every accept path, ownership, stop and the handler; one Playwright
journey with the model-facing calls stubbed.

## Guided pass UI and edit reasons (2026-11-20)

#1295, #1296, #1297, #1298, #1304, #1306 on `staging/guided-pass-ui`, from
Mads's first use of the guided pass on a long note with a slow local model.

- The re-read status line above the step made the step jump; it now uses the
  corner activity card, one per re-read, dismissed when the pass stops.
- The pass shows every edit of the note as one list. The current card keeps
  its paragraph and buttons; the rest are faded with their outcome. Focus
  moves to the new step, because the pressed button leaves with the old card.
  The scroll and focus effect is keyed on the step (or, at the end, on whether
  it is still waiting), so a re-read finishing under a step being reworded
  does not take focus from the box.
- Follow-ups used to jump in as the next step, guarded by a `held` flag and a
  token so a late re-read could not pull the pass back. Mads found the jump
  back jarring, so follow-ups now join the back of the queue (sorted by
  `follows_suggestion_id` being set, then oldest first) and the guards are
  gone. The link to the original is stored on the suggestion so it survives
  a reload (Mads's call on #1297).
- #1306: accepting fast reached the end while re-reads ran. Re-reads are now
  counted per note outside the pass (a restarted pass still waits), and any
  answered re-read refreshes the page, even after a failure or Stop, since a
  timed-out one may already have staged its follow-up. Mads saw no error, so
  the likely cause was simply minutes-long queued re-reads.
- #1304: an optional `reason` on `suggest_edit` and pattern note edits, shown
  as "Why:". Mads: no reason for typos and punctuation; the prompts say so.
  Existing suggestions have none. It costs one sentence of output per edit.
- Migrations were first numbered 0091/0092 against main while #1294 also
  added 0091-0094. #1294 landed first, so they were regenerated as one 0095,
  because drizzle skips a migration whose `when` is older than the last
  applied one.
- Deferred lows in #1317 (clearing finished notes cuts a follow-up's link, the
  count after a restart, an accepted deletion's card moving, a way back from
  the link).

## Assistant staleness by fingerprint (2026-11-20)

#1197, branch `feat/assistant-staleness-by-hash`. Arcs, enrich reads and
chapter summaries were kept honest by marks: every save that could change
what one reads set its stored time fifty years back, inside the save's
transaction and under row locks on the entities. Each review round found a
write path that missed a mark or made a needless one, and the marks were the
reason for most of the lock-order rules.

- Now each result is stored with `requestHash` of the messages it was
  written from, and "out of date" is worked out on read and in the passes by
  building the request again and comparing. Design in `assistant.md`, "Out of
  date by fingerprint". Arcs and enrich already stored the hash (0082);
  chapters gained `summary_input` (0092).
- Removed: `markMentionsStale`, `markEntitiesStale`,
  `markChapterSummariesStale`, `markStale`, `STALE_MARK_BEFORE`, and their
  calls in scene save (title), trash and restore of scenes and stories,
  reorder, split, duplicate, merge, story rename, character rename, mute and
  unmute, draft add back, the mention reindex (with its `changedTargets`
  compare and the story share lock), and the summaries pass. The request
  builders moved to gateway-free modules (`arc-request.ts`,
  `chapter-summary-request.ts`, `request-hash.ts`) so the context builders
  can use them.
- Muting a story no longer clears every arc in the universe. An arc that
  read the muted story is out of date by its hash; its text stays and reads
  as current again on unmute.
- An out-of-date arc stays in the Assistant's context with a short label
  (written before later changes, may be out of date, the scenes are right
  where they differ). The first cut left it out, but any scene edit plus a
  summaries pass puts every arc of that scene's characters out of date, and
  after an upgrade none has a fingerprint, so the Assistant would lose each
  lead's history until the writer refreshed arcs one by one. `arcLine` in
  `context/assemble.ts` is the one place that decides; returning null there
  for an out-of-date arc goes back to leaving it out.
- Since mute no longer clears arcs, an out-of-date arc must not carry a
  muted story's text to the model. The first rule left out the arc of a
  character with a mention in a muted story; the staging review showed the
  mention goes while the arc stays (the scene is deleted or merged, the
  character is written out, the muted story is deleted for good), and the
  arc was then sent. Fixed on `fix/staging-review-1`: the arc job stores the
  stories it read in `characters.arc_summary_stories` (migration 0093), and
  an out-of-date arc is left out unless every one still exists and is still
  read. A story deleted for good counts whether or not it was muted, since
  the two cannot be told apart afterwards. Nothing is written on mute or on
  any other save.
- Arcs from before the column: the migration gives each every story of its
  universe, trashed ones too (more than it read, never less). Treating a
  missing list as unknown at read time was considered: the previous release
  cleared every arc of the universe on mute, so no arc held a muted story's
  text at upgrade, but nothing on the row would say which stories to watch
  afterwards (upgrade, mute B, delete B), so the only safe reading of
  "unknown" is to leave every such arc out, and the owner wants them sent
  labelled. The backfill writes only this derived column. A missing list is
  still read as "leave out".
  `ArcStoryMutedError` and the compare-and-set after the model call went
  with it: a job stores the hash of what it sent, so anything that changed
  meanwhile leaves the result out of date.
- Enrich: a read is sent again when its passages change, which now includes
  passages taken away (trash, mute; the old rule skipped these on purpose),
  or when the entry is renamed. What is recorded on the entry (aliases,
  details, whether a summary is asked for) is left out of the fingerprint:
  the review found that accepting a staged alias or detail bought another
  read of the same passages, once per accept. An accepted alias that finds
  new passages after the reindex is read once more, for the passages.
- Upgrades: nothing is sent automatically for arcs (one without a
  fingerprint shows as out of date until refreshed). Chapter summaries
  without one are rewritten once by the next summaries pass; adopting them
  as current was rejected because a change made after the upgrade would
  have been blessed. Enrich reads without one are adopted free when no
  mentioning scene changed since, otherwise sent.
- Scene summaries were left on their timestamp rule: they read only their
  own row and never used the marks.
- The invariant test became
  `tests/integration/assistant-staleness-invariant.test.ts`. The fake model
  replies with a hash of the request, so a stored arc or chapter summary
  names the request it was written from; after each action the test checks
  that what the app shows as out of date is exactly what changed, that the
  passes call the model for exactly those and a second pass for none, and
  that the action wrote no Assistant column. `character-arc.test.ts` also
  runs saves with a trigger that fails any write to `characters`, and a
  reindex with the mentioned characters locked.
- Staging review round 2 (`fix/staging-review-2`). An arc or chapter summary
  written from a scene's Assistant summary read as current after the scene
  was rewritten, until a summaries pass ran: the request builders read
  `scenes.summary_md` without asking whether it was current, and the removed
  marks used to cover this. Both now take a scene summary only while it is
  usable (`usableSceneSummary`); an arc falls back to the passage and a
  chapter leaves the scene out. The pass rewriting the scene summary changes
  the request again (a real change of input, unless the new summary is the
  same text, in which case both read as current again). The invariant test
  gained a check that does not go through the builders: from the prompts the
  fake model was sent, nothing written from a scene's summary may read as
  current once that scene's text or title has changed. Other readers of
  scene summaries in the context (outline lines, neighbours, `list_scenes`,
  attached outlines, the review survey) send a stale one as it is, as on
  main; left for an issue.
- Same round, upgrade from the release that actually shipped. 3.21.3 and
  3.21.4 already store enrich fingerprints, hashed with the entry's aliases
  and details, so the first pass after the upgrade would have sent every
  entry that has either. The pass now also tries the release's formula
  (`enrichInputAsOf3_21`) and keeps a matching read without a call. Not
  covered: an entry whose aliases or details were edited after its last read
  in the release matches neither formula and is read once more. Chapter
  summaries are kept by migration 0094 where the release counted them as
  current (see `assistant.md`); adopting at read time by the release's
  timestamp rule was rejected, because nothing moves that stamp any more and
  a change after the upgrade would have been blessed. The upgrade fixture
  now starts at 3.21.4 (91 migrations) with fingerprints checked against
  that tag's prompt builders; arcs that were current in the release are
  still current after the upgrade.
- Same round: an out-of-date arc is also left out while a story it read is
  in the trash, like every other Assistant read.
- Known and accepted:
  - A release that rewords a prompt puts every result of that kind out of
    date: the stored result was written from other instructions.
  - The upgrade costs one call per Assistant-written chapter summary that
    the release counted as out of date, or whose scenes had an out-of-date
    summary, on the first summaries pass.
  - The enrich pass runs a handful of queries per mentioned entry even when
    nothing changed, to build the request it compares.
  - A summary is not offered again after the writer clears theirs until the
    entry's passages change.
- `arcRequests` picks the first mention per character and scene in the
  database (`distinct on`), so a context build reads one row per scene, not
  per mention, and only for the characters that make the entity cap. A test
  pins the messages and fingerprint; it passes on the old query too.

## Assistant price and cache lows (2026-11-20)

#1274, lane `fix/assistant-price-lows` on `staging/assistant-remaining`: the
low findings from the quick wins staging review.

- The cache rates moved out of `spend.ts` into `$lib/assistant-cost.ts` so
  the account page can price with them; the meter, the estimate and the usage
  list now share one function.
- Usage rows store the cache shares (migration 0091, three nullable integer
  columns on `assistant_usage`, no backfill). A row without them prices at
  the plain rate as before, so old rows do not change.
- The review estimate prices a first read at the cache write rate on Claude.
  Pricing every estimated prompt token at that rate was considered and
  dropped: the agentic multiplier stands for rounds that resend cached text,
  and doubling those would put the figure far above any real run. Only the
  first request of each scene and the survey requests take the write rate;
  the resent rounds stay at the plain price, which is still above what a
  cache read bills. `estTokens` is unchanged.
- A half price pair no longer refuses the Models form: that pair is skipped
  (its stored entry untouched), the rest saves, and the reply carries a
  message naming the model. The box keeps what was typed.
- Typed prices are cleared when the provider or the endpoint host changes.
  The alternative was a hint beside the boxes; clearing was chosen because a
  stale price meters silently, while a missing one makes the cap say it was
  not applied. Typed context windows are still kept: a wrong window costs a
  failed request, not money, and a local server's window is the writer's own
  launch setting. The switch-provider prompt now says the prices go too.
- The streaming Claude path merges `message_delta`'s running input totals
  the way the buffered path does (shared `mergeDeltaUsage`).
- Still not verified against the live API (no key in the build
  environment): `cache_control.ttl: "1h"`, the `usage.cache_creation` split,
  and whether `message_delta` carries input totals on a web search turn.
  The first two match the published API reference.

Second staging review, branch `fix/staging-review-2-cost`: the tenth for cache
reads was applied to every endpoint, but OpenAI-compatible endpoints report
cached tokens too and charge anything from a tenth to the full price for
them, so a cap could stop late. `cacheReadRate` now gives the tenth to the
Claude provider only and the full price elsewhere. A flat half was
considered: it matches the dearest published discount known at the time, but
a custom endpoint can be any server, and no rate under the full price is safe
for all of them. Usage rows do not record their provider and no column was
added: the list prices with the saved provider, and a row from before a
provider switch seldom has a price left, since a switch drops both the
discovered and the typed prices. An endpoint save that drops typed prices now
says which, in the form's status line (and on a Test connection reply). The
half-price message skips a model the same save took off its last role. A
pattern whose scenes were all deleted or emptied during the survey is dropped
without a failure line. The out-of-date arc hint names "Refresh arc" only
when the button is shown.

## Find and replace across a chapter or story (2026-11-20)

#1302. The editor's Ctrl+F is CodeMirror's own search panel and only sees the
open scene, so changing a word through a book meant visiting every scene.
Decided with Mads: a row under the find panel that widens it to the chapter
or the whole story, plus the chapter row menu and a palette command; story
and chapter only, no universe scope (entity renames already sweep the
universe); no one-step undo of a whole batch, since each changed scene gets its
own History checkpoint.

The work is two calls on `/api/stories/[id]/find-replace`. GET lists every
match per scene in reading order, with a snippet and a fingerprint
(`textHash`) of the stored text it was found in. POST takes, per scene, the
fingerprint and the start offsets the writer kept, and each scene is its own
transaction under the row lock: the text is read again, a changed fingerprint
skips the scene (reported back, never replaced over), and only offsets that
are still matches are replaced. History gets the old text first (a no-op when
it already ends there; it covers scenes that never went through the editor)
and then a labelled checkpoint, the rename sweep's pattern. Marker anchors ride
through `replaceMatches`, which generalises the rename sweep's arithmetic to
matches of any length (a case-insensitive match can differ from the needle),
and the rename sweep now runs on it too. The page lands pending saves before
the search and the replace, then reloads and remounts the open editors so none
saves the old text back; another tab with unsaved typing gets the usual save
conflict. The preview stops listing at 1000 matches. The new write path is in
the stale-marks invariant test and the lock-order harness.

## Background jobs list (2026-11-20)

#1271. A slow local model can keep a review or a details read going for many
minutes, and the corner card was the only place a running job showed; once
dismissed, the job could not be found or stopped outside its own page.

- `BackgroundJobs.svelte` sits in the author bar before the notification
  bell. It is always there (Mads: other kinds of background jobs may join
  it later), showing a spinner with a count while `trackedJobs.list` is not
  empty and a plain icon with "Nothing is running." otherwise. It opens a
  dialog popover (same pattern as the bell) that lists
  each job's label, how long ago it started, its progress, and Open and Stop.
- It is labelled "Background jobs", not "Background work" as first shipped:
  that is the name of a model role on the Assistant settings, and the two
  read as the same thing.
- No new store or endpoint. The list is the activity center's own
  `trackedJobs`, which now carries the label, start time, result link and
  stop function. `/api/assistant/jobs` returns `startedAt` (the pg-boss
  `created_on`) so a job picked up after a reload shows its real age, not
  the time the tab loaded. Opening the list re-reads the running jobs, so
  one started in another tab shows without a reload.
- The corner cards stay: they mark the moment a job starts and finishes. The
  list is the lasting place while it runs.
- A job started in the open tab carries its card's label, which is worded
  for the page it was started on ("Reviewing your story"). Opening the list
  re-reads the running jobs and `labelJob` swaps in the titled label, so two
  stories' reviews can be told apart. A Stop that fails says so on the row
  (`stopError`), since the card that would have said it may be gone.
- Finished jobs are not listed. The notification bell is already the record
  of what finished, and a second history would have to be kept in step with
  it.
- Deferred: jobs that are not the Assistant's (exports, imports) are not in
  the list; they finish in seconds today.

## Models per universe and story (2026-11-20)

#1266. A universe and a story can each choose the Assistant's model per kind
of work; the most specific choice wins (story, universe, account).

- Storage: `universes.llm_config` (migration 0089, additive) holds `models`
  only. A story already stored `models` in `stories.llm_config` and the
  resolver already read them, but nothing could set them.
- `resolveLlmConfig` takes a story id as before, or `{ storyId, universeId }`.
  A story brings its own universe, so story callers did not change. The
  gateway passes the request's `universeId`, which until now was only the
  retrieval reach for tools; the enrichment calls and the character arc now
  send it so universe-wide work runs on the universe's models.
- A role's tuning (reply length, temperature, thinking) stays the account's
  even when a universe or story swaps the model. The chat's own model chip
  resets tuning on a swap; here it does not, because the usual reason to
  swap is a larger window for the same kind of work, and silently losing
  "thinking off" would be the bigger surprise. If a swapped model rejects a
  setting, the error says so and the writer can change it.
- The pickers list what the endpoint lists (`/api/assistant/models`, now
  with `?universeId=`), not the stored discovery snapshots: a local endpoint
  reports neither prices nor windows, so its snapshot is empty.
- An unpicked row says what it will run on, worked out the way the server
  does (`resolveRoleModel` over the levels above plus this level's other
  picks), so "Default: x" is the truth even when this level picks only a
  Rubber duck model.
- Prices, context windows and the spend cap stay on the account. A window
  for a model only a universe uses is set on the account page like any other.
- Review of the PR (nothing high; three medium, six low), fixed before
  merge. A provider switch now clears the picks on the user's universes and
  stories with the account's, since they name the old provider's models. The
  account page gives a context window and price boxes to models chosen only
  on a universe or story (`scopeChosenModels`). The pickers fetch the model
  list only when their section is open. Also: one owner-checked read per
  resolve instead of three queries (the mute is still read whoever owns the
  story, since it only subtracts); the composer's model menu names the
  universe; a pick does not bump the universe's `updatedAt`; tests pin arcs
  and `/enrich` to the universe's model.
- Not built: per-universe tuning, a per-universe mute, and showing on the
  account page which universes or stories override a role.

## Find more reads whole scenes (2026-11-20)

#1170. "Suggest details with the Assistant" sent at most 16 snippets of about
80 characters, so it never saw a nickname or description that did not use the
name. It now reads full scenes.

- Decisions on the issue's open questions (comment on #1170): scenes that
  mention the entity plus the scene before and after each is the default; the
  whole book is a separate choice, offered only from a story and only when it
  fits one request; the background universe pass keeps snippets, because full
  scenes for every entity cost millions of tokens on a novel; the model stays
  the utility model. Storage and resolution allow a per-story model
  (`stories.llm_config.models`), but no screen set it, and a universe had
  no setting at all; both shipped with #1266.
- Not built: batching several entities into one book request with a cache
  breakpoint (step 4 of the issue). It only pays off if the background pass
  reads the book, which it does not.
- The fallback for text that does not fit is by budget, not by chapter:
  scenes are packed into parts in reading order and a scene longer than a
  part is cut at paragraph breaks. Later parts are told what earlier ones
  found as "known", which is the carried list the issue asked for.
- `stageEntitySuggestions` stops at the first summary it sees, so merged
  proposals put the summary last, and a summary is only asked for (and only
  kept) from the last part. The first test run caught this: aliases found
  after a summary were dropped.
- A later part that fails does not lose the paid work before it: each
  part's finds are staged as it is read and the response says `partial`. A
  failure before anything is found is an error as before.
- The estimate measures the real request around the text (it builds the
  message with the entity's fields) and stands in each scene's length for its
  text, so nothing is loaded to count. A test holds it within a tenth of
  what is sent. The request count can be one short when a single scene is
  longer than a part, because the read cuts at paragraph breaks.
- The button never used the stored request hash (only the pass does), so
  nothing about marks or hashes changed here.
- Review of the PR (one medium, nine low). The medium: a read was one web
  request with no ceiling on parts, staged only at the end. It now makes at
  most 8 requests and refuses a longer text up front (the count says
  `tooLong` and the editor explains), and stages per part. The background
  spend cap still does not apply to the button, as for every inline surface;
  the count and the ceiling bound it instead. Lows fixed: a failed count no
  longer starts an unconfirmed read; at story scope the entity must belong
  to the story's universe; a cut-off later part passes its advice on; costs
  under a cent say so; tests now pin the mute and trash filters and the
  cut-off path.
- Moved to a background job before merge. Mads's local model takes minutes
  per reply, and a web request held that long gets dropped. The read is now
  an `assistant-enrich` job carrying `read` (one unfinished read per entity
  by singleton key), handled by `entityDetails` like a character arc:
  activity card, Stop, a notice at the end. That removed the 8-request
  ceiling and `tooLong` (the job has the spend cap and Stop instead) and put
  the read under the background spend cap. The editor waits on the job,
  then reloads the page data and adds the new rows; if the writer has left,
  the notice links back to the entry. The estimate stays a plain request.
  The job stores the entity's name for the card rather than looking it up
  across three tables. Not covered by a test: the route's queue call for
  the owner (the handler, the running-jobs list and the editor flow are).
- The whole-book choice shows after the first press on a page, because the
  count that says whether it fits comes back with that press. Counting on
  every entry open was the alternative and was not worth a query per click.

## Assistant quick wins (2026-11-20)

Staging branch `staging/assistant-quick-wins`.

- #1275 (lows from the staging review). Pattern pass: the note checks
  which of the pattern's scenes exist and have text when it is written, not
  when the attempt read its scenes, so its "Shows up in" list and "first 25"
  line leave out a scene deleted or emptied during the survey. The fix loop
  no longer cuts the list to 25 up front; it stops once 25 scenes have been
  asked about, so a scene skipped as deleted or empty gives its place to the
  next one and the note's count matches the scenes that get fixes. A skipped
  scene is not marked done: a continued run asks about it if it was restored
  in between, and skips it again (no request) if not. An emptied
  scene is skipped like a deleted one. Chat: `listChat` fills in the entry
  type of an entity attachment stored before #1185 by looking the id up in
  the three entity tables, so old chips get the right icon with no stored
  row rewritten; an entry that is gone keeps the person icon. Tests: the
  hostile Markdown cases run through `renderReplyBlocks` too, the chat route
  has checks for a forged `entityType` and for a cut and renamed entry, and
  `e2e/assistant-reply-blocks.spec.ts` covers a reply arriving in two parts
  and a notice replacing a longer reply. Left alone: a tab loaded before
  #1276 misreading a renamed entry in the attachments header. Only the
  server could fix it, by keeping the old header format and sending names
  in a second header for good, and a reload already clears it.
- #1031 (prices for Claude): the Anthropic models list reports no prices, so
  the meter had none and a cap on Claude never applied. Each model a role
  runs on now has a typed price pair on the account page, stored per token
  in `llmConfig.modelPricingManual` and laid over the discovered snapshot
  (the same split as `modelContextManual`), so it survives rediscovery. A
  built-in price table was considered and dropped: it would go stale and the
  meter must never guess. The boxes show for suggested models as well as
  picked ones, since a suggested model is what runs when nothing is picked.
  A half-filled pair holds its own autosave; the server refuses a half pair.
- #1031 (cache): the meter prices Claude cache writes at 1.25x (5 minutes)
  and 2x (1 hour) and reads at 0.1x. An account setting picks the cache
  lifetime; the default stays 5 minutes because 1 hour doubles the first
  send. Not verified against the live API: the `ttl: "1h"` marker and the
  `usage.cache_creation` split are built from the published API shapes.
  The usage list and the review estimate still count at the plain price.
- #1255: a bare `/who` or `/find` keeps the typed line; the "first 25" line
  on a pattern note counts live scenes only (`patternLiveScenes`, shared
  with the fix loop).
- #1207: each apply request of a pattern pass re-reads the scene, and a
  scene deleted since the run started is skipped with no request.
- #1185: a stored entity attachment carries its entry type, read on the
  server and never taken from the browser, so the chip shows the right icon.
  Attachments stored before this kept the person icon until #1275.
- #1003: asked for a frame throttle on the streaming reply. A throttle would
  not have fixed the lost selection, so the bubble renders one `{@html}` per
  top-level Markdown block (`renderReplyBlocks`) and finished blocks keep
  their DOM nodes. No timer.
- #1002: closed, not planned. No Assistant text reaches `teaser()`; every
  caller passes text a person typed.
- Staging review round 1: nothing above low. Fixed from it: the sent
  attachments header carries a name only when it differs from the one the
  browser sent (eight long non-ASCII names could pass a proxy's header
  limit, and an old tab misread the new format), a label cut no longer
  leaves half an emoji, the apply re-read is scoped to the story, the 1 hour
  help says "about twice", and three help passages no longer say a price
  must come from the endpoint. The rest is filed as issues.

## Tooling issues (2026-11-20)

Staging branch `staging/tooling-issues`, the open "tooling" issues after the
triage.

- Staging review round 1: nothing high. The medium was that accepting a
  suggestion and a new story from a draft never ran in the default eight
  seeds of the stale-mark test, so those paths were unchecked in CI. The
  rare list is longer, the actions pick inputs that apply, and a last test
  fails when any action never ran. Lows: the lock-order file had two lock
  targets nothing took (one dropped, the other now taken by a suggestion
  operation), the upgrade seed had a mention offset three characters short,
  two comments still said a restore always writes rows, and the one-clock
  rule matched client files under `src/routes` and missed `hooks.server.ts`.
- #1237: the transcript replay now says what it used to skip. When the endpoint
  reported no counts, no spend may be recorded (before, the check returned
  early), which pins the known gap that an OpenAI-style stream cut off before
  its closing usage frame goes uncounted; the adapter does not guess. The
  retry or fail label is only checked on the buffered path, because nothing
  retries a live stream, so the unused flag on the stream side was removed
  and the file header says so. The unused `# stream: buffered` header is gone.
- #859: the worker's fixed sweeps moved from inline `boss.schedule` calls into
  `src/worker/schedules.ts` (`WORKER_SCHEDULES`, `registerSchedules`), because
  `index.ts` runs at import and could not be tested. The test registers them
  on a real pg-boss and compares against a second written-out list on purpose,
  so a dropped sweep or a changed cron fails. The backup schedule stays in
  `index.ts` since it depends on saved settings.
- #1214: the stale-mark invariant test drives eleven more write paths: find
  and replace, restoring a scene or entity revision, accepting a review
  suggestion, saving a draft, restoring a scene from one, a new story from
  one, creating an entity from the story page, setting and clearing a mention
  pin, and accepting an alias suggestion. Actions that only apply in a rare
  state (restore, unmute, pin) get a second draw so the default eight seeds
  reach them; 24 seeds passed locally. It found one needless
  mark: restoring a revision whose text the scene already has rewrote the
  row, which marked the summary out of date and paid for the same summary
  again. `restoreRevision` now leaves such a scene alone.
- #1239: no selector can follow a variable into a later `.set()`, so the
  one-clock rule now refuses `const x = new Date()` outright in server code,
  and covers `src/routes/**/*server.ts`, `src/hooks.server.ts` and `src/worker/**` too. Nothing on main
  tripped it. A `new Date()` written where it is compared is still fine.
- #1235: the lock-order harness now counts advisory locks. A holder takes
  each one in turn (story-scenes, a scene's revision lock, draft-restore), and
  the ones an operation holds while it waits are read from `pg_locks`, so two
  operations under the same advisory lock are no longer treated as able to run
  together. Ten operations were added: delete a trashed scene for good, find
  and replace, restore a scene revision, accept a review suggestion, restore
  and add back a scene from a draft, new story from a draft, purge universe,
  save a place and a lore entry. That found one crossing: saving a character
  or place with a first story note held the entity row and then took the
  story (the note's foreign key), the opposite of a universe purge.
  `saveEntity` now takes the story key share first, the order `row-locks.ts`
  sets. It could not bite in practice (a purge only runs on a universe in the
  trash past its window), but the rule is now kept everywhere. The limits
  that stay (pairs only, rows inserted mid-run, story delete being the purge)
  are in the test header. The file takes about 3 minutes, up from 2.5.
- #1155: payload tests for the split route sit in `route-authz.test.ts`, which
  already calls the real handler. The editor half was not added: the position
  maths is covered by the `withoutRanges` tests, and what is left of
  `cursorOffset` is one line joining it to the selection.
- #861: CI retries once, not twice, and uses Playwright's github reporter, which
  lists tests that needed the retry as "flaky" on the run summary. Failing the
  run on any retry was the other option; it was left out because a load hiccup
  on an unrelated PR would then block a merge.
- #1238: the upgrade fixture seeds a second character (Tam) whose arc and read
  were out of date under the previous release's rule, so migration 0083's
  backfill is exercised: after the upgrade his arc is marked stale and enrich
  re-reads him and leaves Mara alone. The capped-review step no longer stubs
  the job lookup: `legacyJobCategories` moved out of the handler closure to an
  exported function, and the test reads a finished job from a real pg-boss on
  the legacy queue (and checks that other categories do not take the run
  over). Not done: normalising CRLF in `gatherStory`. The review pages read
  scenes through it and anchor suggestions by offset into the stored text, so
  changing the text there is not safe; the export keeps the stored bytes and
  the next save of the scene normalises them.

## Issue triage fixes (2026-11-20)

The 2026-11-19 triage closed 13 of 78 open issues as not planned or duplicate and ranked the bugs that were left. Fixes, in that order:

- **Chat box commands (#1219).** A typed line is a command only when its first word is one (`isSlashCommand`); anything else stays in the chat box with a hint, and a space in front of the "/" sends it as a message. The typed menu's highlight resets whenever the text changes. A failed model save goes back to the last choice the server stored, not to an earlier unsaved pick. The context picker finds an untitled chapter as "Chapter N". Not done: the whole-book price already reads "each time it is sent", which covers tool rounds well enough, and earlier attachments are still not resent (the note to the model now says so).
- **Review editor (#1173).** Text the review editor takes from the server no longer queues a save, so a second outside change inside the save delay cannot be refused and raise the conflict banner for a writer who typed nothing. After a merge or duplicate the editor remounts even when the reload fails, with a notice. The base-revision ordering point was left: it needs a comment to land in the same instant as an autosave commit, and History corrects itself on the next save.
- **Chat turns the panel and the server agree on (#1215, #1232, #994, #1183, #1180).** The `done` frame now goes out after the reply is stored, so "saved" in the panel means stored. A reply cut short with no text is stored (empty, with its note) and the panel shows a line in its place that is neither inserted nor sent back. A failure before the message is stored answers 500 with `x-chat-stored: 0`, and the panel puts the message back like a refused one; a send that got no answer at all says it may not have been sent. Deleting a new chat whose first send was stopped asks first. Attachment names come from the server's own read, and the model list takes the panel's story so a model set for that story is offered. Left as they are, with the reasons on the issues: a Stop in the instant between store and `done`, /write passages and the greeting riding as history until a reload, hiding non-chat models (endpoints do not say which are chat models), and a cache for the model list.
- **Composer polish and accessibility (#1212, #1181, #1189).** /context and /model, typed bare, only open a list, so they no longer wait for a reply in progress (with words after them they still wait, since the answer would be a message that takes the rest of the reply; /model still waits while a new chat's first reply is on its way, as the chip does). A list opened by a command returns focus to the chat box when it closes. The highlighted typed command is read out through a polite live region, since a textarea cannot be a combobox. The model menu's models are a labelled group, and its loading note is a status outside the menu. Left alone from #1212: the popup roles on the + and "/" buttons, the sent-message chip style, a model list cache, and the surrogate-pair cut.
- **Pattern pass loose ends (#1203, #1205, #1206).** The estimate counts the tool schemas from the specs the gateway offers instead of a fixed 700, leaves the pattern pass out when the endpoint cannot call tools (as the run does), and words the fix line as rounds. `leave_pattern_note` reads at most 40 edits a call, cuts a long kept list to the note's room, reports an edit with no original, and is refused on a turn scoped to one note. A resolved note takes no more edits, and the guided pass counts only edits on live scenes. #1208 (a book pass skips a habit an open chapter note names) was closed: the writer already has the note, and a second one would repeat it.
- **Smaller fixes.** A scene split proposal is located on the same line endings the split itself uses, so a scene saved with CRLF no longer refuses a valid split (#1165). Two user turns in a row (a stopped send followed by a new question) reach the model as one turn, since some endpoints refuse turns that do not alternate (#1233). A whole-book pattern pass that is continued resumes by the scenes it has surveyed, not by a count, so a chapter added in front is not skipped (#1202). The pattern re-read got a route test, and the help says it is one request outside the spend cap (#1204). A story's "edited" time on the library counts trashed scenes, so trashing the newest scene does not move the story back in time (#1148). The two-factor e2e waits for the full code and cancels a setup left pending by a failed attempt (#1211).
- **Staging review round 1.** A typed line that gives words to a command that takes none ("/new idea for chapter three", "/help me with this") is kept in the chat box with a hint and not run; before, the command ran and the line was gone. A re-read on a resolved pattern note is skipped before the request, and scenes deleted since the survey no longer take places in the 25-scene cut. Two e2e tests that passed without their change were rewritten to fail without it.
- **Closed without a change.** #1142 (a cancelled job's handler overlapping the writer's next job) cannot happen on one worker: pg-boss holds the writer's group slot until the handler settles. #1152 and #1208 were closed with the reasons on the issues.

## Upgrade-path test (2026-11-19)

Several findings were data or jobs left by the previous version, while the
suite starts from an empty, fully migrated database. #1196 added
`tests/integration/upgrade-path.test.ts`: a database of its own is migrated
only as far as the last release (`upgrade/previous-release.json`), seeded with
that release's row shapes in plain SQL (`upgrade/seed.sql`: CRLF bodies, a
writer's own summary, a capped review under the old scope key, arcs and reads
current at the time, a trashed universe), migrated to head, then
summarised, enriched, continued, exported, saved and restored. Nothing may be
lost or asked of the model again. Pending jobs on the legacy queues are not in
the fixture (the capped review's job lookup is stubbed, so only its stored
state is checked): pg-boss creates its own schema when the worker starts, outside the
migrations. The release flow in `CLAUDE.md` now refreshes the fixture.

## Stream transcripts (2026-11-19)

Stream handling and spend metering drew a finding nearly every review round,
each fixed with a test for that one case, so #1195 added recorded replies
under `src/lib/server/llm/providers/transcripts/` (one `.sse` file per case,
with `# key: value` lines for the expected outcome) and `transcripts.test.ts`,
which replays each through the live stream (and the buffered reply, where it
takes a stream: all Anthropic files, and OpenAI ones with a failed status)
whole, one byte at a time and in uneven chunks, and replays every reply cut
off at each event boundary. The rules are the same for every file: the outcome
and text match, chunking changes nothing, only failures a resend could fix are
retried on the buffered path, and billed usage is never below what the body
reported and is marked estimated exactly when the output count is a guess. It
found one gap: a live stream that dropped before its stop reason ended as a
finished reply (and was saved to the chat as one). It now ends with an error
in both adapters, as the Anthropic buffered path already did (OpenAI's
buffered call is one JSON body). The chat panel keeps the partial text of such
a reply on screen with a note that it was not saved. A chat or recap reply the
server did not store is left out of the turns the next question sends: an
error, a stream that closed without finishing or failed to save after it
finished, a writer's own Stop, and the panel's own hints (/write and /rewrite
passages, which are never stored, are still sent). Errors and hints, including
failed /write and /rewrite replies and the "not sent" notices, offer no
insert; text that arrived before a Stop or a break can still be inserted. A
slash command waits while a reply is on its way, as the composer already did
for chosen commands. Merging main brought the composer's refused and unreached
paths, which follow the same rules. An OpenAI-style error frame partway
through (OpenRouter sends one when its upstream drops) also ends in an error
now, where it used to finish the reply. The first review also found the OpenAI
stream dropping a last line sent without a newline (losing its text, finish
reason and usage); `no-final-newline.sse` covers it. The spend rule only bites
where the body reported counts: the OpenAI stream sends usage only in its last
chunk and does not estimate, so a cut-off OpenAI stream records no spend. A
new edge case is a new file.

## Lock order and race harness (2026-11-19)

Deadlocks and positions shared by two scenes were found one pair of
operations at a time (#1147, #1149, #1159, #1160), so #1192 added
`tests/integration/lock-order.test.ts`. It does not guess which pairs to race.
For every write operation and every row of a small seeded story, a holder locks
the row first, so the operation stops there, and the rows it already holds are
probed with `nowait` in each lock mode (the mode it waits for comes from its
tuple lock in `pg_locks`). Two stops that each wait for a row the other holds,
in conflicting modes, with nothing they both hold keeping them apart, are a
deadlock. The same stops then pause one operation while each structural
operation (split, restore, reorder, chapter create and delete, and so on) runs,
and check that both finish without a database error and no two scenes or
chapters share a position. The race half takes about two minutes; the stops
dedupe by held rows. Disabling a fix brings its finding back, which is how the
harness was checked.

The rule it enforces is in `src/lib/server/row-locks.ts`: a story's scenes,
then the story, then entities, then its chapters, each lowest id first, with
`for no key update` on rows that are only updated so foreign-key checks pass.
Reorder, chapter delete, scene create and both restores now lock the story's
scenes first; purge locks the story before its chapters; chapter create locks
the story row. #1140 (story rename against a character's first story note) did
not reproduce: the rename's update takes no key update on the story, which a
foreign-key check's key share does not wait for, since the slug's unique index
is partial and so not a key.

The first staging review found that a story with no scenes had no scene rows
to lock, so two scene creates read the same top position and a chapter delete
racing a create failed on the foreign key. `lockStoryScenes` now locks the
story row (`for no key update`) after the scenes, and a separate block of the
harness races both on a story with no scenes, since the seeded story always
has five. The second review found that a change waiting in
`lockStoryScenes` did not lock a scene the change before it inserted (a
`for update` select only sees rows that existed when it started), so a mention
rebuild of that scene could deadlock with it on the story row. An advisory
lock on the story now comes first, so the waiter's scene select starts after
the insert commits. Chapter move now reads the chapter list under its locks.
Both have tests in the same block.

## One clock (2026-11-19)

Several review findings came from comparing a stamp written with the app
server's clock (`new Date()`) against one written by Postgres (#1120, #1139,
#1143). #1194 made the database clock the only one for stored timestamps:
every `updated_at` `$onUpdate` now writes `clock_timestamp()` (no migration:
the hook is app-side, and inserts already used `defaultNow()`), the remaining
`new Date()` writes became `now()`, copies (duplicate, add back, new story from
a draft) stamp with `dbNow`, and the review continuation stamps `reviewedAt`
with `dbNowText` and compares it with `updated_at` in SQL at microsecond
precision. The reviewer email digest keeps its watermark as Postgres text for
the same reason: a JS Date dropped the microseconds, so a reply in the same
millisecond as the last digested one was never sent. An ESLint rule refuses
`new Date()` in `.set`, `.values`, `sql` templates and `$onUpdate` under
`src/lib/server`; a `new Date()` held in a variable first is not caught, so the
rule is in `design.md` too. #1143 also said a continued review counts a redone
scene's notes twice. It does not: a pass counts only the notes it adds, and the
earlier ones stay open, so the count is left as it was. Stamps read back into a
JS Date (the mention index's `loadedAt`, `dbNow`) still lose microseconds, but
only in the safe direction: a scene can be reindexed once more, never missed.

## Assistant composer (2026-11-19)

Mads asked for the Assistant panel to feel less cramped and to look more like
Claude Code's chat panel in VS Code, mostly the input bar. Issues #1171
(composer, command menu, model chip) and #1172 (adding context as chips), on
`staging/assistant-composer`.

- #1171. The header became the chat title plus two icon buttons (chat list,
  new chat); the old name row, the "Mute for this story" link and the "..."
  menu by the send button are gone, their actions moved into one command
  menu. The command list in `#lib/assistant-slash` gained a label and a
  group per entry so the menu, the typed `/command` matcher and `/help` read
  one list; every menu entry is also typable (`/history`, `/delete`, `/mute`,
  `/model` are new). The menu keeps focus in a text field and points at the
  highlighted row with aria-activedescendant, since the composer itself is
  the filter when "/" is typed; the button opens it with its own filter
  field. Mads chose a per-chat model setting over a per-story one, so it is
  stored on the chat row rather than in `stories.llm_config`; the panel sends
  it with every message and the chat endpoint saves it when it changed, so
  there is no separate settings endpoint. Only the chat role takes the
  setting: `/write` (co-author) and the recap (utility) keep their own
  models. The model list is fetched live from the endpoint when the menu
  opens, merged with the models already set for any role so an endpoint that
  cannot list models still offers something. The two menus are their own
  components (`AssistantCommandMenu`, `AssistantModelMenu`); the rest of the
  composer stayed in `AssistantPanel`, since splitting it further would only
  move its state into props.
- #1172. Attachments are their own list on a user turn next to the existing
  selection `reference`, rather than a generalised reference: the quote is
  text the browser holds, an attachment is an id the server reads, and the
  two fold differently. Mads chose to allow stories from other universes and
  to let the writer pick how much of a story goes in (outline, whole book,
  one chapter or scene). Only the newest turn carries its attachments in
  full: resending a whole book with every later message would multiply its
  cost, so earlier turns get a one-line note naming what was attached. The
  attachment budget is separate from the transcript budget and is applied
  after the transcript is fitted, so a large attachment cannot push the
  conversation out. Deferred: an "@" trigger in the composer (the + and
  `/context` cover it), and searching scene text in the picker (titles
  only for now).
- #1172 review. The picker's searches got their own rate bucket so typing
  cannot use up the chat's. The server answers with the keys of what it
  actually sent (`x-chat-attachments`, a trailing "!" when cut), and the
  panel's chips follow it, so a scene trashed after it was picked does not
  keep a chip and the live transcript matches the stored one (a mismatch
  would change the summary anchor). The attachment share dropped to 0.3 with
  a 4000-token fallback for an unknown window, and the fold wrapper is
  counted. A body cannot close its own `<attachment>` block, and the fold
  says the material is not instructions.
- Staging review round 1. A chat that picks a model without an effort level
  also drops the account's effort for that model (the provider rejects it).
  The attachment share has a 100k-token ceiling, since the message is resent
  on every tool round, and the picker prices and labels a book on what will
  actually be sent. A send without settings runs on the stored ones. Client:
  one composer popover at a time (a typed "/" waits), Tab leaves a popover
  rather than run a command, menu commands wait for a reply in progress,
  model sits ahead of mute so "/m" and Enter cannot mute, and the popover
  search fields share `.input.sm`. Filed as low: #1183, #1184, #1185.
- Staging review round 2. A command chosen from the button menu cleared the
  writer's draft (it shared the typed-command path, which clears the line);
  now only a typed command clears it, and a command that takes input goes in
  front of the draft. Tab in the chat box completes a command name and runs
  nothing (it had run Mute). A send the server refuses before storing it (a
  rate limit) comes off the transcript and goes back in the chat box with its
  context. A picked model starts from default tuning (output cap,
  temperature, extra parameters were set for the account's model), and
  `chatEffort` in `#lib/assistant-chat` is the one place the chip's effort is
  worked out. Only a settings object sent with a message is saved. Catch me
  up, `/write` and `/rewrite` keep their own roles' models; the help says so.
  Filed as low: #1188, #1189.
- Staging review round 3. A send that never reached the server (offline)
  now comes back to the chat box like a refused one, and a draft that did
  not go out is merged back with anything typed or added since rather than
  skipped. A typed command clears the line only once it is accepted, and a
  /write or /rewrite that cannot go ahead or fails puts the line back. Only
  a new chat sends its model choice with a message; a stored chat changes it
  through the chip's own save, so a stale tab cannot overwrite it. A new
  chat whose first turn fails to store is dropped again. Filed as low: #1212.
- Staging review round 4. A failed model save now puts the earlier model
  back on the chip (it had kept showing the new one while the chat ran on
  the old). Saves run one after another, and a message waits for a pending
  save so the picked model answers it. The chip is locked while a new chat's
  first message is in flight, since that message carries the choice. A
  starter suggestion no longer clears a typed draft. Filed as low: #1215.
- Staging review round 5. A catch-up that starts a new chat now saves the
  model picked on the chip to that chat (it had run on the default while the
  chip showed the pick). The command menu's group headings no longer share
  ids with options, so the highlighted row is announced. A send reads the
  draft after any pending model save, so text typed meanwhile is not wiped,
  and a /who or /find line that cannot go ahead goes back to the chat box.
  Filed as low: #1217.

## Stale-mark invariant test (2026-11-19)

Review rounds kept finding missed or needless Assistant out-of-date marks one
write path at a time, so #1193 added
`tests/integration/stale-marks-invariant.test.ts`: seeded random sequences of
writer actions (edits, paragraph swaps, renames, status, moves, trash and
restore, split, merge, duplicate, story rename, mute, chapter rename, move
and delete, entity edits) run through the real server functions, and after
each step the marks are compared with the request the Assistant would send.
`arcRequest` and `enrichRequest` were split out of the arc and enrich passes
so the test builds the same request the passes do.

Rules it holds: anything whose input changed is marked; a scene or chapter
summary whose input did not change is not (no fingerprint check, so a paid
call). For enrich only a passage not read before counts, since trash and
mute only take passages away and do not pay for a re-read; the entity's own
name, aliases and details are the writer's to edit and are left out too.
Needless arc and enrich marks cost no call (the fingerprint check) and are
only printed.

After each round of passes the marks are checked again, so a pass that
rewrites a scene summary without marking its chapter fails too. The fake
model's replies follow the prompt, and the test keeps the prompt behind each
reply, so a summary is judged against the input it was actually written
from (a copied summary maps to its source's prompt). A chapter whose scenes
came, went or moved may be marked even when its input comes out the same.
A duplicate keeps its source's summary under the title "X (copy)" (#1089), so
a title that differs only by "(copy)" is not owed a refresh.

What it found on main: renumbering chapters on a chapter move or delete bumped
every chapter's `updated_at`, so each summary read as out of date (#1200);
reordering scenes inside one chapter left its summary current (#1146). A
removal that shifts a full 16-passage enrich sample is reported, not failed
(#1201). Write paths not yet in the action list are #1214. Probes that
disabled one mark at a time (the summaries pass's chapter mark, a character
rename's arc mark, the trash and restore marks) each failed the test.

## November review (2026-11-18)

An independent review of every November change (5f3b182..HEAD) filed #1006
to #1017 and #987, fixed in severity order on `staging/november-review`
(#1018 to #1030). Three staging review rounds followed, each by three fresh
reviewers (drafts, review and export; LLM server and worker; Assistant
client), fixed in #1033, #1035 and #1037.

- Out-of-date marks: trash, merge, restore and unmute push `arc_summary_at`
  (and, for restore and unmute, `assistant_enriched_at`) back to a mark fifty
  years before `clock_timestamp()`, so each mark is distinct. `arcIsStale`
  treats anything before 2000 as a mark. The arc and enrich writes are a
  compare-and-set against the value read at the start, at millisecond
  precision, so a mark that lands during the model call survives. A fixed
  epoch mark was tried first; a second mark then equalled the first and was
  overwritten.
- Clearing review notes: notes are stamped with `clock_timestamp()` and the
  page's cutoff is compared in SQL to the microsecond. A two-second margin was
  tried and kept notes the writer had just seen. The cutoff goes back to the
  start of the oldest open transaction, so a note still being saved when the
  page loaded is kept.
- Assistant chats: the panel holds the next chat id, reuses it after a stopped
  first question (which the server may have stored), and rotates it after a
  recap that did not start its chat. The server reports `x-chat-created` and
  `x-chat-title` so the panel can adopt a chat at once.
- Cut-off arc and enrich replies raise `ReplyCutOffError`; the worker settles
  the job as failed for that attempt and notifies once instead of retrying.
- Left as a design note: `surfaceMaxTokens` raises small caps on thinking
  models, which can cost more than the cap suggests.

## Saved drafts (2026-11-16)

Draft names (#824, 2026-11-17): the name field is prefilled with the next
ordinal ("Second draft"), "Draft 13" past the twelfth, stepping past names in
use. Words over a bare number because writers say "second draft"; computed on
load from the existing labels, so there is no stored counter to keep in step
with renames and deletes.

Clear review notes (#823, 2026-11-17): Mads asked for a way to start a
fresh review round after saving a draft. Drafts never captured review
notes, so clearing them cannot touch a draft (a test pins that). The
dialog (`ClearReviewsModal`, opened from the foot of the Comments panel)
offers "Finished notes only" (resolved threads, decided suggestions and
their discussions) or "Everything", as Mads chose over a single delete-all.
`clearReviews` locks the story's suggestions, then its threads (the lock
`addComment` takes), so neither a first reply on a suggestion nor a reply
in a thread can land in something being deleted. Notes on scenes in the
deleted list stay with those scenes.

Compare drafts (#825, 2026-11-17): a Compare tab on the draft page,
against the working draft or another saved draft, always older to newer.
`compareDrafts` (pure, `src/lib/drafts.ts`) matches scenes by id, or by
the id a scene added back came from; drafts now record that as
`DraftScene.origin` (absent in older drafts, which then show such a scene
as removed and added). Matching runs in passes, exact id first, then
`origin`, then `root` (the first draft of a chain of add-backs, kept as
`scenes.metadata.firstDraftScene`), so a copy never takes the place of
the original, and the Story tab's per-scene state shares the same
`matchScenes`. Unchanged scenes are only counted, and a card's text is
drawn only when it is opened, so a long novel's page stays light. The working side reads only chapters and scenes
(`workingOutline`), not the worldbuilding. Prose only for now; comparing
worldbuilding and notes is left for when someone asks.

Low review items (#819 to #822), same PR: a cover change and a draft save
now meet on the story row (`for update` in `replaceCover`, `for share` in
`saveDraft`, which retries a serialization failure), so a draft cannot keep
an old cover that was just freed; deleting the last draft that shows an old
cover frees it. Draft relationships now carry `relationTypeId`, so "New story
from this draft" copies story-only relationships. The library table links to
Saved drafts under the title rather than carrying the cover menu, because its
sideways-scrolling card would clip a menu. A failed draft delete still
reports above the list: the row is gone by then.

Review round on PR #815: "Add back to working draft" made a fresh copy on
every click, since the copy has a new id. Matching by text was tried and
dropped (empty or repeated scene text matched the wrong scene); the copy now
records the saved scene's id in `scenes.metadata.fromDraftScene`, and an
advisory lock stops a double submit. The importer skips `drafts/` before
counting entries, so a story export with many drafts still imports, and says
the drafts were left out. The compare view moved into a shared `DiffView`
(`<ins>`/`<del>`), also used by `RevisionPreview`.

Saved drafts (#812, branch `feat/saved-drafts`): a user asked, through Mads,
for "editions" of a book they could always go back to, like a GitHub release,
with switching from the library cover and the editor. Decided in discussion on
the issue: private (not for the public page), a total freeze including the
worldbuilding (like a git tag), named "draft" in the UI, per-scene restore and
publishing a draft both in, and no limit on how many.

- Storage is one jsonb snapshot per draft (`story_drafts.content`, typed in
  `#lib/drafts`), read in a repeatable-read transaction. Not built on
  `revisions`: those have no thinning yet, but #599 proposed one, and a
  hard-deleted scene takes its revisions with it. The `publications` table was
  the other candidate and was not reused: it is tied to the admin gate, the
  handle, and one current row per story.
- A draft copies the universe's whole entity set, not only the story's
  members, because a story names entities it never declared. Scene, chapter,
  note and entity ids are kept so a scene can be compared with and restored
  onto the live one, and so notes and relationships still point at the right
  things inside the draft.
- Inline images are not pinned: nothing deletes an inline image today. The
  cover is the one image that can go (replacing it deletes the old file), so
  the cover replace now keeps a file that a saved draft still shows.
- The draft page wears the Page shell like print preview: it reads the work
  but has none of the workspace's panels. The worldbuilding tab lists the
  frozen entities with how often the draft names them (the same
  `detectMentions` rules as the editor) rather than underlining the prose.
- "Save as draft..." lives in story settings rather than a dialog in the
  editor, so leaving the editor flushes any pending save through the existing
  navigation guard before the snapshot is taken.
- Publishing a draft reuses the publish form (a "What to publish" select), so
  the pen name prompt and the edition label work unchanged; the edition
  records `source_draft_id`, set to null if the draft is deleted.
- Deferred: underlines and hover cards inside a saved draft's prose, and a
  side-by-side view of two saved drafts.

## Admin accounts list (2026-11-16)

#813 and #814, one PR. Every row action sat inline in one flex row that never
wrapped, so the table grew past its card and the right-aligned actions started
at a different spot per row. The account actions moved behind one "Actions"
menu per row (`AdminUserActions.svelte`), the invite allowance got its own
column, and the Role column folded into an Admin tag beside the name (a
Writer tag on every other row said nothing). Below a 640px card the table
stacks per account through a container query, since a scroll wrapper would
clip the menu. Last active is `greatest(max(sessions.last_seen_at),
users.last_login_at)`: the daily sweep deletes expired sessions, so the sign-in
time covers accounts idle for more than 30 days. No migration.

## Issue review round (2026-10-29)

Second open issue review (2026-10-29): seven open issues, each with a review
comment; the owner settled the decisions on the issues. Six lanes ran in order
on `staging/issue-review-2`, lane commits saying "Refs" for partial work so the
staging squash closes only finished issues. #769 (base path in server-built
links) was closed as not planned: no base path is configured or planned.

- #760: a Playwright trace showed the cause was not the retry collision the
  issue guessed. The scene's navigation data landed while the test was typing,
  the editor remounted, and keys were lost. The spec now runs as its own user
  with run-unique names and waits for the scene data before typing; the
  product-side race is #772.
- #744: `-ink` twins (`--danger-ink`, `--status-draft-ink`,
  `--status-revised-ink`) darkened in light and warm and plain in dark, and
  author text mixes `--auth` towards black by `--ink-share`. The owner's
  author colour is `--accent`. `contrast.test.ts` checks the pairs and scans
  src for raw text uses of the plain colours. Badge letters (#775) and the
  focused mark tint (#776) were split out.
- #766: the cookie route. The root layout sets `codex-tz` and refreshes once
  per page load; the server reads it (`requestTimeZone`) into
  `page.data.timeZone`, and the format helpers take it, so server HTML and the
  hydrated page agree. Rendering times only in the browser was rejected: it
  flashes empty timestamps.
- #731: setting rows are a container query on `.admin-main-inner`, so fields
  in modals and the admin invite row keep the stacked layout. Step 3 became
  `.contents-nav` "On this page" links rather than new sidebar items, hidden
  on narrow screens.
- #737: the review shell's narrow tab bar moved to `theme.css` as the shared
  `.pane-tabs` plus `data-mtab` pattern and the story editor uses it. `.app`
  got an explicit `minmax(0, 1fr)` column; without it the formatting toolbar
  widened the page at 720px. A review pass caught Assistant actions opening a
  hidden panel and focus dropping to the page on a pane switch; both fixed.
- #752 in two PRs. `refreshAll` keeps `page.state`, which nothing reads, so it
  is a straight swap. The `#lib` codemod was a regex over quoted specifiers,
  not `sv migrate`, to avoid reprinting `.svelte` files. TypeScript maps
  package.json `imports` without trying extensions, so `tsconfig.json` keeps
  a matching `paths` entry, and the worker loader adds extensions for `#lib`
  as Node does not.
- #772 was added mid-round. Clicking the open scene was harmless, not the
  cause the issue guessed; the loss was a switch to another scene, where the
  old editor stayed writable until the next scene's data landed. The page
  pauses typing (read-only, dimmed, no caret) while it leaves the scene. An
  independent review of staging then found the same gap around split, merge
  and the Assistant's split cards, no guard in the whole-story view, and a
  failed save turning the pre-navigation flush into an endless retry loop. All
  of these now go through one `pauseTypingWhile` plus `flushEditors` pair. A
  second review found the guard ignored a save already on its way (it read
  `dirty`, which clears when the request leaves; it now reads
  `hasUnsaved`), Duplicate did not flush, Back and Forward were re-issued as
  new history entries, and a hard stop on a failed save trapped a writer whose
  save could never succeed (a conflict, a 403). A failed save now asks
  whether to leave without the latest changes. A review loop followed (fix,
  merge to staging, fresh review). Round 1 found that read-only alone let
  dispatched edits through (a Tab continuation, a finished image upload,
  coauthor Insert); a transaction filter now drops them. Round 2 found that
  the pause was a flag, so overlapping actions unpaused each other (now a
  count); that a dropped upload or Insert lost its content (uploads now wait
  for the pause to end, and Insert keeps its draft); that a second click
  during the save was lost (the guard now goes to the last place clicked);
  and that the review shell's pane tabs dropped focus (it now shares
  `focusShownPane` with the story editor). Round 3 found that holding a
  finished upload until the pause ended lost it when the editor was torn
  down (it now lands with an annotation the pause filter lets through, and
  the flush takes a second pass for it), and that "Load newer version" on a
  paused editor kept the old text and then saved it over the newer one (the
  conflict buttons now wait for the pause). Split, merge and duplicate now
  refuse to start while another runs.
  Round 4 found only lows, filed as #794 to #802 and then fixed on staging:
  an image still uploading now counts as unsaved (leaving asks first),
  Back and Forward stay paused until the replayed move starts, a click
  during a split or merge is queued rather than dropped, scene-changing
  buttons are disabled while paused, the save timeout grows with the scene
  and up to 16 unsettled fingerprints are kept, "On this page" shares the
  sidebar with the route list and follows scrolling, pane tabs apply up to
  960px while Plan and Notes scroll sideways inside the body, and a
  timezone the server rejects is reported once per tab.
  Round 5 (after those fixes) found that a Back clicked during a split could
  land one step off (queued moves now replay by URL), that leaving during an
  upload stored its placeholder (the save now leaves pending uploads out and
  maps marker anchors past them), and that "On this page" used a fixed line
  that missed Insights' own scroller and the last groups on Security (the
  line now follows the scroller and the heading's scroll margin, and at the
  bottom the section jumped to wins). Leftover lows went into #805.
  The open follow-ups then shipped on staging too: entity badge letters sit
  on the palette colour mixed 65% towards black (#775); the focused review
  tint dropped to 12%, with hover and the focus pulse capped at 15%, the
  most author-coloured text keeps AA on in every theme (#776); and a split,
  merge or duplicate whose move is cut short by Back or Forward reloads the
  page data and remounts the editors, while a queued move keeps its data
  refresh (#805). Goto options such as replaceState are not visible to
  `beforeNavigate`, so a queued move cannot keep them.

Under parallel load a few e2e specs (notes, import-story, two-factor,
author-review) fail about once a run on staging as well; not chased this round.

## Issue review round (2026-10-26)

Open issue review (2026-10-26): all 20 open issues got a review and fix plan
comment, and the decisions were settled with the owner on each issue. Work ran
in five parallel lanes, each PR targeting `staging/issue-review`, then a final
thread for #735, #736 and #630. Decisions worth keeping: runtime `ORIGIN` stays
via the custom server entry (`server.js`) on SvelteKit 3; Node 26 landed before
the kit upgrade; three text tiers stay, with a warning when a custom accent
fails contrast; tooltips no longer open on focus; one axe spec covers the main
pages; coverless stories get a random palette colour (nullable
`stories.cover_color`); the Plan sidebar's new-category form became a "Manage
categories" link; "View: Edit" is only the accessible name; #731 shipped step 1
only (anchored, capped settings column with a wide variant for admin tables),
with setting rows and in-section navigation deferred; guest, reader and public
bars keep a small theme picker and focus mode drops its control. The story
workspace reflow was split out to #737 and is not scheduled. Follow-ups filed
along the way: #744, #752, #760, #766, #769.

## Phase 1 - Foundations

* [x] 1. Scaffold SvelteKit + TypeScript on adapter-node, with test harness
* [x] 2. Drizzle + node-postgres, users table, first migration
* [x] 3. Dockerfile, compose.yaml (app, worker stub, postgres, Caddy), compose.dev.yaml
* [x] 4. Run the stack in Docker end to end
* [x] 5. Sign-in: sessions, auth_tokens, password check, server hook guard
* [x] 6. Seed admin via SQL; verify sign-in and the approval gate

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
- [x] 24. Scheduled off-site backups and restore (v1.8, cadence in v1.8.1): hourly pg_dump from the worker to any S3-compatible bucket with skip-if-unchanged and tiered retention (48h full, 30d daily), admin "Back up now" with visible run history, restore script drilled live against MinIO, now RustFS since #682 (took the slot SillyTavern vacated; pulled forward from step 33 because no disaster recovery means not production ready). WAL/PITR noted as a Phase 6 candidate.
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
endpoint. Started 2026-06-09. Every step below through entity enrichment
merged as #324-#335 and shipped together as v3.0.0; later items carry their
own PR and version.

Nothing left open in Phase 9 (the last two items, #845 and #846, shipped
2026-11-18).

- [x] Staging review round 6 of staging/review-follow-ups: paused review
      editor and history order (2026-11-19). While a review-centre merge or
      duplicate had typing paused, the pause filter dropped an accepted
      suggestion and the outside-text sync, but the saver still rebased onto
      the stored text; a merge that then failed left the editor on the old
      text with a matching base, and the next keystroke silently undid the
      accept. Both dispatches carry the server's own text, so they are now
      marked landsWhilePaused, and the saver only rebases or adopts once the
      editor shows the text. Accept and Reject stay usable while paused.
      saveSceneBody re-checks deleted_at and a live story under the row
      lock, so a save queued behind a merge that trashed its scene gets the
      404 instead of writing into the trash and showing "saved". Revision
      rows are stamped with clock_timestamp() rather than the transaction
      start, so a split or merge checkpoint that waited on the scene lock
      sorts after the autosave it waited for, and a later autosave no longer
      coalesces over the pre-split text. Merge widens the markers of a blank
      first scene against the merged body instead of leaving them empty.
      After a duplicate the review centre picks the new scene once the
      refresh has loaded it, so the editor mounts once rather than briefly
      showing another scene. The Write page's SceneEditor has no such
      server-text path while paused (its Load newer is already refused).

- [x] Staging review round 5 of staging/review-follow-ups: split and
      merge history, CRLF anchors (2026-11-19). Split and merge recorded
      their new text as an autosave, which rolls into the latest autosave
      when it is under two minutes old, so typing and then splitting
      replaced the full pre-split text in History with the head alone. They
      now record checkpoints with a label ("Split into two scenes", "Split
      from the scene before", "Merged N scenes"), which always insert. The
      remaining paths that read a body stored with \r\n in stored offsets
      now go through toLf like split and merge: remapMarkerAnchors (the
      review save, restore, accepted suggestions, draft saves) diffs the
      newline texts, the prose sweep replaces in and stores the newline
      text, the TODO list slices quotes from it, and locateSplitInStory
      searches it and returns its fingerprint. Merge now clamps the
      target's markers to its trimmed text and widens any marker left empty
      by the trim to one character, as split does; split marks its
      chapter's summary out of date, as duplicate does. The lockStoryScenes
      comment no longer claims every scene insert takes that lock (#1160).
      The Assistant's split proposal still validates its passage against
      the stored text; the confirm normalises both, so only proposing a
      passage across a \r\n line break is refused.

- [x] Staging review round 5 of staging/review-follow-ups: review centre
      merge and duplicate save first (2026-11-19). The review centre sent
      a merge or duplicate straight away, so an edit still waiting to save
      (a debounce, or a retry after a dropped connection) was left out: the
      merge trashed the scene it read, and the retried save then got a 404,
      losing the words. It now follows the Write page: pause typing, land
      the review editor's pending save, refuse with the same message if it
      fails, then remount the editor on the stored text. The flush loop and
      the message moved to scene-actions.ts so both pages share them;
      ReviewEditor gained flushSave, isDirty and a paused prop to match
      SceneEditor.

- [x] Staging review round 4 of staging/review-follow-ups: merge markers
      on CRLF scenes (2026-11-19). mergeScenes worked out where each
      merged-in marker lands from the raw bodies, so a target stored with
      \r\n shifted every merged-in marker by one character per line break,
      and \r\n in a merged-in scene's leading blank space threw off the
      trim. It now runs every body through toLf first and stores the merged
      body with plain newlines, the same rule splitScene follows. On split,
      a marker covering only the seam's blank space moved to the new scene
      as an empty range, which createMarker refuses and the editor cannot
      show; it now takes the first character of the new scene.

- [x] Staging review round 3 of staging/review-follow-ups: CRLF splits
      and split locking (2026-11-19). The Codex archive import kept \r\n
      line breaks (and so missed front matter, whose first line read
      `---\r`); it now reads every text file through toLf
      (`src/lib/line-endings.ts`, shared with the document importer). A
      body already stored with \r\n could never be split from the editor:
      CodeMirror reads it with plain newlines, so the fingerprint never
      matched. splitScene now also accepts the fingerprint of the newline
      text and cuts that text, storing both halves with plain newlines;
      an offset placed in the stored text (the Assistant's locate) maps
      across with lfOffset. Marker anchors on such a body already count in
      the editor's newline text, since only the editor creates them, so
      they need no mapping. Split and duplicate now lock every scene row of
      the story, lowest id first like mergeScenes, then re-read the scene
      with inLiveStory: two splits in one story could hand out the same
      global_position (an UPDATE's snapshot misses a row the other split
      inserted), and locking in heap order could deadlock a merge. Rows of
      trashed scenes are locked too, since the shift moves them as well. A
      marker starting in the seam's blank space and running past the cut
      ended up inverted in the first half; one starting at or after the end
      of the trimmed first half now moves to the new scene with its text.

- [x] Staging review round 3, spend wording and help links
      (staging/review-follow-ups, 2026-11-19). Notices and the review modal
      said a run with estimated counts spent "up to" an amount, but only a
      failed attempt whose thinking was hidden is metered at its output cap;
      others count the characters that arrived, and a finished stream with
      no usage report is estimated the same way. spentPhrase now says
      "about $X (estimated)", matching the account page. The account help
      no longer says a failed request is counted at the most it could have
      cost, and names the details pass rather than `/enrich`. The capped
      review modal links to the account help.

- [x] Staging review round 2 of staging/review-follow-ups: split,
      duplicate and chapter marks (2026-11-19). Writer trust: splitScene
      read the body outside its transaction and wrote the head over the
      row with no lock, so an autosave landing in between was dropped from
      the live scene. It now locks the scene first and cuts the text read
      under the lock, refusing with a conflict when that text no longer
      matches the fingerprint of the text the offset was placed in (the
      editor sends it; the Assistant's passage path uses the text the locate
      read). duplicateScene locks its source the same way. Duplicating a
      scene into a chapter, and adding a draft scene back into one, now mark
      the chapter summary stale. trashScene marks the chapter the trash
      update returns rather than one read before the transaction. The scenes
      a split or duplicate shifts keep touched_at as well as updated_at
      (keepTimestamps, shared with deleteChapter).

- [x] Staging review round 2, Assistant help text, paused streams and stop
      lookup (staging/review-follow-ups, 2026-11-19). The account help said a
      capped run "never goes over"; the cap is checked between steps and web
      search fees are not counted, so the text now says the last step can take
      it a little over, and names /enrich and character arcs as capped too.
      The in-app hint is one line with a link to the help. A paused plain
      chat stream had become an error on this branch, discarding a reply the
      writer paid for; it now ends as done and keeps the text (resuming needs
      the raw blocks the stream does not carry). jobRunSignal returns a
      release, called through withJobRunSignal once the work returns, so the
      abort pg-boss sends on normal completion no longer triggers a job lookup.
      stopAssistantJob rejects a non-uuid id up front and compares id as a
      uuid, so the lookup can use the primary key.

- [x] Staging review round 1, jobs and billing (staging/review-follow-ups,
      2026-11-19). A refused arc settles as failed with a "declined" notice
      instead of being retried (and billed) by pg-boss; the review, summary,
      continuity and enrich jobs already counted a refusal as a failed item
      and did not throw. pg-boss aborts job.signal the same way for a Stop
      (a cancel the heartbeat notices), an expiry and a shutdown, so the
      worker now runs the Assistant's requests under a derived signal
      (jobRunSignal) that checks the job's state when it aborts and passes
      only a cancel on as a WriterStopError reason; the interactive routes
      wrap request.signal the same way. The Claude adapter skips the
      output-cap bound only for that reason, so an expired or shut-down
      attempt still counts at the cap before its retry carries the spend. A
      plain chat stream that is cut off now emits an estimated count
      (thinking deltas included) before rethrowing, so a stopped chat is
      logged as estimated rather than unreported. Because a stopped request
      can be under-counted, the account page reads "about" with the
      estimated-request count rather than "up to", and the help says so. The
      agent loop's pause counter resets with each round, as the paused text
      does. A job that finishes while Stop is in flight is no longer shown
      as stopped: the card waits for the stop's answer and shows stopped
      only when it was taken and the job did not end done.

- [x] Staging review round 1 of staging/review-follow-ups: scenes and
      summaries (2026-11-19). Writer trust: mergeScenes read the bodies
      outside its transaction, so an autosave landing before the write was
      replaced (only History kept it; this predates the staging branch). It
      now locks the scenes lowest id first and reads them under the lock.
      Migration 0084 was edited before shipping: touched_at is added
      nullable, its clock_timestamp() default set by a second ALTER, no
      backfill, so the scenes table is not rewritten; readers use
      coalesce(touched_at, updated_at). A scene summary write now marks its
      chapter summary stale in the same transaction (the in-memory
      touchedChapters set is gone), so a pass stopped before the chapter
      pass leaves the chapter due. A reorder bumps touched_at only for the
      scenes movedScenes names plus any that changed chapter, a chapter
      delete bumps none, and a scene moved to another chapter marks both
      chapters' summaries stale. markChapterSummariesStale, moveChapter and
      deleteChapter lock chapters order by id first. A reorder within a
      chapter still leaves its summary as it is.

- [x] Review runs, job spend and job stops (staging/review-follow-ups,
      2026-11-19; #1117, #1105, #1103, #1045, #1046, #1093, #1106, #1108,
      #1113). Each queued Assistant job's spend is kept in a new
      assistant_job_spend table keyed by its pg-boss id (written only when a
      cap is set, swept with the review runs), so a retry starts its meter
      from what earlier attempts spent. SpendMeter takes the seed and a
      serialised persist callback; the gateway and adapters are untouched.
      The arc job now meters too (a retry at the ceiling asks nothing and
      says so) and settles on EndpointReplyError instead of retrying it. A
      cap hit on the last scene with the cross-scene pass still to run marks
      the run capped, so a continuation runs only that pass. Adopting a
      capped run drops failed scenes, and scenes edited since their pass
      (per-scene reviewedAt stamps on the run state; rows saved before have
      none and keep the old behaviour), so both are reviewed again. A
      continuity continuation's note count starts at zero. A load or adopt
      error now fails the attempt (ReviewRunLoadError) and the worker leaves
      it to pg-boss to retry, telling the writer only on the last attempt.
      A coalesced 409 shows an "Already running" card and picks up the
      running job's card instead of a failure; the summaries 409 now says
      edits made after the pass starts need another update. For a hung job,
      a running card has a Stop button (POST /api/assistant/job-stop, which
      cancels the writer's own job and frees its key; the worker aborts at
      its next heartbeat). A shorter expiry or a no-progress check was not
      built; Stop covers the stuck case without guessing a timeout.

- [x] Staging review follow-ups: usage log and Claude adapter (#1116,
      #1127, #1123, #1102, #1104, #1125, #1074, #1083, #1085, #1094,
      2026-11-19). The spend meter keeps its output-cap bound for a failed
      thinking attempt, but the usage log no longer presents it as reported:
      `assistant_usage` gains an additive `estimated` flag (and a
      `web_search_requests` count), the account page marks those rows and the
      30-day total says how many it includes, and a cost or a capped run's
      notice that includes estimates reads "up to" instead of "about". A
      request the writer cancelled (aborted signal or AbortError) skips the
      bound, since no further attempt follows for it to protect. Plain
      streamed turns now write their row in a finally, so a caller that stops
      reading at done, an error or a cancel still logs it; a streamed error
      event carries an estimated count first. The "cap not applied" notice for
      missing counts says "for every request" and "could not be fully
      applied", since per-request metering still caps the rounds that did
      report. Web search fees are counted from server_tool_use but not priced:
      no per-search price is discoverable from the endpoint (Claude models
      have none either, #1031), so the help article says the fee is outside
      the cost and the cap. Adapter: SSE data lines join until the blank
      line; a stream with no or a generic content type is sniffed; broken
      tool input outside a max_tokens stop reaches the dispatcher as raw text
      (a bad-call result) instead of empty arguments; refusal and pause_turn
      get their own finish reasons. A refusal throws ReplyRefusedError (a
      failed scene or reply), a paused buffered turn is resumed up to twice
      by sending its blocks back, and a paused or refused plain stream ends
      as an error. The billing explanation lives in a new "Usage and cost"
      section of the account help article, linked from the Usage heading.

- [x] Review follow-ups: mention index and stale marks (2026-11-19).
      A mention rebuild now reads the scene body under the scene's row lock,
      in the transaction that writes the index, so a save landing between
      the read and the stamp can no longer leave old text stamped current,
      and a trashed scene restored meanwhile is indexed rather than stamped
      empty (#1073, #1128, #1112). The rebuild locks the scene before its
      mention rows, but the story purge deleted mentions before scenes, a
      real deadlock the two-connection test reproduced (the story itself was
      not the problem); the purge, and Delete forever on a scene, now lock
      the scene rows first, lowest id first (#1095). Passages are compared in
      reading order, so swapping two paragraphs that mention a character
      marks the arc, while text added above only shifts positions and does
      not (#1070, #1119). A reorder marks only what the scenes outside the
      longest run that kept its relative order mention, so moving one scene
      to the end marks one scene's characters, not the story's (#1087). A
      story rename marks its scenes' entities for arcs and enrich, a
      character rename marks its arc, and a scene rename now marks enrich
      too: passages are labelled with story and scene titles, and the
      request hash still skips an unchanged request. This reverses the
      earlier call that renames were not worth a paid re-read (#1069,
      #1096). Restoring a universe no longer marks the whole universe: the
      rebuild keeps marking while the universe is in the trash (nothing in
      it is read until the restore), so the restore has nothing left to
      mark; a trashed or muted story still skips marks and is marked on
      restore or unmute (#1107). The enrich request hash leaves out whether a
      summary is still wanted, so a read that staged a summary does not make
      the next unchanged read a paid call; entities hashed with a summary
      known get one re-read the next time they are marked (#1086). An entity
      deleted while an enrich pass runs is passed over instead of failing the
      pass (#1072).

- [x] Summaries and scene-change follow-ups (#1071, #1111, #1114, #1120,
      2026-11-19). A summary is now stamped with the updated_at it was built
      from (the guarded write already proves the row still has it), not a
      clock reading, so currency compares a column with a copy of itself;
      inserts set updated_at on the database clock and saves on the app
      clock, and either could be ahead. The title-only save moved to the app
      clock like every other update. The guarded write also checks the old
      stamp, so trashing, restoring or merging a scene marks its chapter's
      summary stale (stamp moved just behind updated_at, a new value each
      time) and a pass already writing from the old scenes does not save
      over the mark. Moves between chapters still leave the chapter summary
      as it is (scene-order.ts was in another lane; see #1100). The pass now
      stops at the first no-model or turned-off refusal and the notice says
      so, settled as failed like enrich, and a pass whose every write lost
      to an edit says that instead of "found nothing". New
      scenes.touched_at (clock_timestamp(), bumped by every Drizzle update
      through $onUpdate and by the reorder for the rows it moved) drives the
      library's edited time and the scene a story opens on, so a status
      change, move or restore counts as editing the story while updated_at
      stays the prose clock. clock_timestamp() so the scene a split or
      merge acted on reads later than the scenes it shifted in the same
      transaction. Migration 0084 adds it (see staging review round 1 for how it was
      reworked before shipping).

- [x] Staging review round 8 (#1122, 2026-11-18). The output-cap floor
      from round 6 also applied to a finished reply without an output count,
      so a compatible endpoint that omits it booked every thinking request at
      the cap. The floor now applies only to a failed attempt whose thinking
      streamed no text; otherwise the streamed characters are the estimate.
      Mid-stream timeout_error and rate_limit_error are retried as 504 and
      429, as their HTTP statuses were before the buffered path streamed.
      Summary stamps are written from the app clock again, the clock that
      sets updated_at, since the two are compared (#1120; the database's
      now() had made a same-millisecond edit read as summarised, which CI
      caught). The round's low findings went to #1123-#1125.

- [x] Staging review round 7 (#1118, 2026-11-18). Web search results are
      billed as input but only message_delta's running totals report them,
      so a reviewer stream that failed after searching was metered at its
      opening prompt size. Until message_delta arrives, the size of the
      result blocks is now estimated into the input side. An output count
      sent as a string by a compatible endpoint is read too. The round's low
      findings went to #1116, #1117, #1119 and #1120.

- [x] Staging review round 6 (#1110, 2026-11-18). The round-5 estimate
      counted streamed thinking, but current Claude models stream thinking
      with its text omitted and bill it in full, so a stream that failed
      mid-thought still metered about 1 output token. Once a thinking block
      opens, a failed stream is now metered at the request's output cap, the
      most it can cost; over-counting only stops a capped run early. A
      finished stream whose message_delta carried no output count uses the
      same estimate. The round's low findings went to #1111-#1114.

- [x] Staging review round 5 (#1098-#1101, 2026-11-18). Writer trust
      first. A Claude stream that failed partway was metered at
      message_start's output count (about 1), since the real API sends
      message_delta only at the end; the round-4 fixture had sent one before
      the error. Until a message_delta reports the count, the output is now
      estimated from the text, thinking and tool input streamed so far, with
      the same four-characters-per-token estimate the context budgets use
      (moved to `context/budgets.ts` so the adapter does not pull in the
      database modules) (#1098). A resumed review carried the earlier run's
      run-level messages (the summary cap, the unpriced cap) into its notice,
      and a same-job retry listed the unpriced cap twice; only scene failures
      carry over now, and each attempt raises its own run-level messages
      (#1099). Non-prose scene updates (the position shift of a split or
      duplicate, a status change, trash, merge's trash, restore, a chapter
      delete) no longer bump `updated_at` through `$onUpdate`, which had made
      the scenes' Assistant summaries look stale and re-billed them
      (`keepUpdatedAt` in `scene-access.ts`). Every consumer was checked: save
      conflicts use body hashes, the sweep's watermark only needs prose
      changes, and the story page's "last edited scene" is better for it. The
      one path that relied on the bump was restore: the trash deletes the
      mention rows, and the bump was what let the reconcile sweep rebuild
      them if the queued rebuild was lost. Restore now clears
      `mentions_indexed_at` instead (#1100). The mute path clears the arcs it
      locked by id rather than re-running the filter (#1101). The
      `DraftScene` comment now says what happens to summaries copied from
      drafts saved before the stamp was recorded (they stay the writer's
      own). Filed and left open: #1102-#1108; #1031 and #1080 gained notes.
- [x] Staging review round 4 (#1075, #1089-#1092, 2026-11-18). Writer
      trust first. A stream that failed partway (overload, server fault, a
      close before the stop reason) was billed but its tokens were dropped
      (#1075). The Claude adapter now fills usage in place as frames arrive
      and attaches what had been billed to the error it throws; the gateway
      logs a usage row for it and meters it before it retries or gives up,
      and the run's total includes it. Metering moved into the gateway: the
      meter rides on the request and `recordUsage` feeds it for every
      request, so the agent loop's earlier rounds are metered even when a
      later round throws. One behaviour change: a round the endpoint
      reported no counts for now marks the cap as not applied even when other
      rounds reported, where the old per-run sum hid it. A 0 input count on
      message_delta (some compatible endpoints) no longer overwrites the real
      one from message_start. Copies (duplicate scene, draft add-back, new
      story from a draft) stamp `summary_generated_at` with the copy's own
      `updated_at` when the source summary was current for its text, so the
      next pass does not pay to summarise the same text again; a stale one
      keeps its old stamp and is refreshed (#1089). Drafts now record
      `summaryCurrent` per scene and chapter; older drafts count as stale.
      Comparing the summarised text with the body was weighed and dropped:
      the timestamp test is the one the summary job itself uses
      (`summaryIsCurrent`, now shared). Draft chapters carry the stamp too,
      so a copied chapter summary stays the Assistant's (#1090). Muting a
      story locks the arc-bearing characters `order by id for update` before
      clearing them, the order `markStale` takes (#1091); no test, since a
      deadlock test would be timing-dependent. An enrich pass that stopped
      for no model, the Assistant off, failures in a row, or read nothing is
      settled as failed, and the enrich done label is now "Finished
      suggesting details for the entries in X" (#1092). Filed and left open:
      #1093-#1096; #1076 gained a note on checking running jobs before a send.
- [x] Staging review round 3 (#1078-#1082, 2026-11-18). Writer trust
      first. The #1064 rule (adopt only a capped newest row) lost progress
      when a continuation of a capped run threw or was cancelled: its own
      uncapped row is saved as soon as it starts and became the newest
      (#1078). A run that starts from a capped run's progress now records
      `carriedForward` on its state, and the newest row is adopted when it is
      capped, or carried forward and never finished (still part-way, or
      aborted); a newer run that finished cleanly still blocks adoption, and
      the legacy key follows the same rule. Marking the capped row as
      consumed was weighed and dropped: the continuation's row already holds
      the capped run's scenes plus its own. Migration 0083 (custom SQL)
      backfills the stale marks that the move from watermark staleness to
      marks dropped at upgrade (#1079), mirroring the old `arcIsStale` and
      `entitiesToEnrich` queries from `main` (live, unmuted story; the arc at
      millisecond precision as the old JavaScript compare was; enrich also
      skipping a trashed universe); 0082 was left as it was. Duplicate scene,
      draft add-back and new story from a draft now copy
      `summary_generated_at` with the summary, so a copied Assistant summary
      stays refreshable (#1080); drafts record it in their content from now
      on, and older drafts, which never stored it, still copy the summary as
      the writer's own. There is no writer edit path for scene summaries, so
      nothing else changes. `markStale` locks every target `order by id for
      update` (characters, places, lore) before it updates, so a mark by
      scene and a mark by entity cannot deadlock (#1081); the test holds the
      lowest id and checks the mark has not taken a higher one. The arc
      card's done label is now "Finished with the arc for X", true for every
      outcome (the notification says which); the enrich result counts
      entities passed over as unchanged, and the notice only says it could
      not read the entries when none were read or passed over (#1082). Filed
      and left open: #1083-#1087; the suggested fix for #1073 is on the issue.
- [x] Staging review round 2 (#1064-#1068, 2026-11-18). Writer trust
      first. `adoptCappedRun` took the newest capped row for a scope, so a
      capped run that a later run had finished was carried into a fresh
      review weeks later, which then skipped (and reported reviewed) scenes
      the writer had rewritten. It now looks only at the newest row for the
      scope and adopts it only if that row was capped (#1064). Clearing or
      flagging the adopted row was weighed and dropped: the newest-row rule
      covers it with no extra write. Copyedit keys gained their categories in
      #1062, which orphaned runs capped before the upgrade (#1065). The old
      rows do not record their categories, and adopting one for any
      categories would report scenes as checked for categories nobody
      checked, so the fallback reads the categories from the old job on the
      legacy queue (pg-boss keeps a completed job for seven days by default)
      and adopts only the newest legacy row, only if capped, only on a match.
      A forgotten job starts the run over. Remove it with the legacy queues
      (#1041). Reverses part of #1050: a stream `overloaded_error` or
      `api_error` is now thrown as `Endpoint returned 529` or `500`, so the
      gateway retries it exactly as it does that status (#1066). The earlier
      reasoning held that a job's retry would try again, but the review and
      summaries handlers catch everything, so nothing did, while a buffered
      529 had always been retried. Other stream errors and a 2xx that is not
      a reply stay final. An arc check whose compare-and-set loses to a mark
      now returns `changed` with its own notice instead of `unchanged` (the
      "up to date" notice) (#1067). `untrash` now marks what the row mentions
      in the same transaction as the revive, one transaction per slug attempt
      so a unique violation does not abort the retry; the three callers no
      longer mark separately (#1068). Filed and left open: #1069-#1076.
- [x] Review follow-ups on the enrich and arc marks (#1047, #1055-#1061,
      2026-11-18). Writer trust first. `rebuildSceneMentions` marked entities
      before stamping the scene, while saves (a title change), reorders, trash,
      merge and the summary job lock the scene row and then mark entities, so a
      rebuild and a save could deadlock and the killed autosave (or the
      un-retried keepalive save on tab close) lost the edit. The rebuild now
      stamps the scene first (`where deleted_at is null`, so a scene trashed
      since it was read is left as the trash left it), then the story, then
      entities: the order is scene, story, entity everywhere. A test holds the
      scene row in one connection, starts a rebuild, then marks the entity, as
      a save does. The summary job overwrote `summary_md` unconditionally and
      wrote back the `updated_at` it read before the model call, so a summary
      typed while the model ran was lost and an edit in that window had its
      `updated_at` rolled back (so the next run did not refresh it). The write
      is now raw SQL (no `$onUpdate`, and `updated_at` is never set) guarded
      by `updated_at` (as text, to the microsecond) and `summary_md` as read;
      a miss skips the scene for the next run. Chapters got the same guard.
      Cost: marks fire on any passage change, but enrich sends at most 16
      passages and arcs the first passage per scene without a summary, so
      many marks led to an identical request. Two fixes were weighed: making
      the mark consider only the passages that are sent, which would repeat
      the selection (per-story spread, even sampling, summaries) in the save
      path and still drift from it; and storing a hash of the exact request
      with the watermark. The hash was chosen: one comparison, exact by
      construction, and the marks stay simple. Additive migration
      `assistant_enriched_input` (characters, places, lore) and
      `arc_summary_input` (characters). The background pass skips the model
      and just clears the mark on a match (inline enrich always calls); an arc
      refresh does the same only when the arc is marked, returning
      `unchanged` with its own notice, so the writer can still ask for another
      take on a current arc. Not fixed: the "may be out of date" line still
      shows for such a mark until the writer refreshes. Reorders now compare
      rank among live scenes, not the stored `global_position`, so closing a
      trash gap marks nothing. `NoModelError` (a subclass of
      `AssistantDisabledError`, so callers that end on a refusal still do)
      gives the arc and enrich notices their own wording; the arc notices no
      longer name the button, which reads Write arc or Refresh arc. A generic
      arc failure now waits for the last attempt before notifying (#1047),
      like the muted-story case.
- [x] Staging review fixes for the streamed Claude replies and the
      exclusive queues (#1049-#1054, 2026-11-18). The buffered path now
      accepts a stream that ends after `message_delta` without
      `message_stop`, as `chatStream` already did. A mid-stream `error`
      event and a 2xx that is neither an event stream nor JSON throw
      `EndpointReplyError`, which `isTransientFailure` treats as final. The
      mid-stream case was considered for a longer backoff limited to
      `overloaded_error` and `api_error`, but overload outlasts any wait a
      request can sensibly hold, and the failed attempt already generated
      tokens; the review job's own retry or the writer tries again. Its
      partial usage is not recorded, like every other failed request. A
      stream cut off with no stop reason is still retried, as a transport
      drop. JSON with no content type is read as JSON (sniffed by a leading
      `{`). Review scope keys now carry the categories (see #986 below).
      Tests added for the streamed web search and citation blocks,
      `redacted_thinking`, cache usage merged across `message_start` and
      `message_delta`, and a job in pg-boss's `retry` state still holding
      its key on the exclusive queue.
- [x] Enrich and arc re-reads follow the passages, not `scenes.updated_at`;
      a rejected summary is never suggested again (#977, #992, 2026-11-18).
      The staleness checks compared `max(scenes.updated_at)` over mentioning
      scenes with the watermark, so a status change, reorder, or lifecycle
      update re-read every entity those scenes mention, while an accepted
      alias that linked older scenes went unread. `mentions_indexed_at` was
      considered and rejected: the reconcile sweep reindexes a scene whose
      `updated_at` moved (so a status change still moves it) and a rename
      reindexes the whole universe. Instead `rebuildSceneMentions` compares
      each entity's passages (the snippets enrich and arcs read) before and
      after, and marks only the entities whose passages changed, with the
      existing fifty-years-back mark (`markEntitiesStale`), only for scenes
      the Assistant reads (a live, unmuted story; restore and unmute already
      mark). The checks are
      now just "never read or marked", so there is no query against scenes
      and no migration. Edits outside a mention's snippet window no longer
      trigger a re-read, which is the intended precision. The summary job
      marks arcs for a scene whose summary it rewrites, since arcs read
      scene summaries, and a scene rename or a reorder that moves a scene
      marks arcs only. Scene titles do reach enrich (each passage is labelled
      `[story / scene title]` by `snippetLine`), and reading order picks which
      passages are sent when there are more than 16; neither tells the model
      anything new about the entity, so a rename or reorder is not worth a
      paid re-read, and the next passage change sends the new labels. Review follow-ups: restoring a universe (or reviving a trashed
      standalone one) now marks like a story restore; the rebuild reads
      whether the Assistant reaches the scene inside its transaction with a
      share lock on the story and universe rows, so an unmute or restore in
      flight cannot slip between the read and the mark; and the enrich and
      arc compare-and-set compare the watermark to the microsecond (carried
      as text), since a JS Date drops microseconds and marks are now
      frequent. Upgrade note: an entity or arc that was already
      behind by the old rule at deploy is not re-read until its passages
      change again. For #992, Mads chose "never again once rejected";
      `summaryClosed` in `entity-suggestions.ts` holds the rule, and
      `enrichEntity` uses it to stop asking the model for a summary.
- [x] De-duplicate Assistant review and summary jobs (#986, 2026-11-18).
      Both queues ran under pg-boss's default policy, where a `singletonKey`
      alone adds no unique index, so a repeat request queued (and paid for) a
      second run and the 409 branch never fired. A policy cannot change once a
      queue exists, so the jobs moved to new queues created `exclusive`
      (`assistant-review-v2`, `assistant-summaries-v2`); exclusive is "one
      queued, retrying or running job per key", where `singleton` would still
      allow many queued and `stately` one queued plus one running. The old
      queues keep a worker for one release so jobs queued before the upgrade
      drain, and the status and running-jobs lookups read both names; removal
      is #1041 (search `LEGACY_ASSISTANT_`). Handlers pass the job's own queue
      name to the retry-notice check so a drained job is looked up where it
      lives. The summaries send dropped its 30-second `singletonSeconds`
      window (the only thing deduping it before, and only within a slot) and
      now returns 'coalesced' like the others, so the endpoint answers 409
      instead of a 503. The app-side check-before-send alternative was
      rejected as racy. A copyedit's key includes its categories in
      canonical order (`full:<story>[:<chapter>]:<cats>`, `general` for the
      sparing pass), so a review for other categories is its own job rather
      than a 409, and a capped run is only adopted by a run checking the same
      categories (#1052). Release note (#1053, also on #1041): rolling back
      to a version before this strands jobs queued on the v2 queues, which
      the older worker does not read; and while a deploy has the new web up
      before the new worker, jobs sent to the v2 queues wait for the worker
      restart.
- [x] Enrich and arc failure notices (#988, #991, 2026-11-18). The enrich
      pass now stops after three failed reads in a row (`MAX_FAILURES_IN_A_ROW`)
      when entities remain, and on `AssistantDisabledError` at once, each with
      its own notice. A cut-off reply does not count toward the run and resets
      it, since the endpoint answered. A pass that read some entries counts
      the failed ones in its notice. The arc job settles as failed without a
      retry when the Assistant is off, like a cut-off; a story muted mid-write
      raises `ArcStoryMutedError`, still retried, with its own wording.
- [x] Claude's buffered replies stream under the hood (#967, 2026-11-18).
      The Anthropic adapter's `respond` (every agent loop round, so every
      Assistant review round) sent `stream: false`, so a long thinking reply
      wrote nothing until it was done and could outlast the 10 minute egress
      idle timeout. It now sends `stream: true` and `assembleMessage` rebuilds
      the message a buffered call returns (blocks by index, thinking with its
      signature, tool input from `input_json_delta`, the stop reason, usage
      from `message_start` merged with `message_delta`), then reuses the
      existing parsers, so the result, cut-off retry and spend accounting are
      unchanged. The SSE line splitting moved into `sseFrames`, shared with
      `chatStream`. An error event mid-stream throws `EndpointReplyError`,
      which the gateway does not retry (#1050); a stream that ends with no
      stop reason throws, and one that ends after `message_delta` without
      `message_stop` is returned whole (#1049). A 2xx body that is JSON, with
      or without a JSON content type, is still read as one, for an
      Anthropic-compatible proxy that ignores `stream`; any other non-stream
      body is an `EndpointReplyError` too (#1051). Not changed: the
      OpenAI-compatible adapter's `respond` buffers the same way, but its
      streams differ by server (tool-call deltas, usage frames), so it waits
      for a sign that local reasoning models actually hit the timeout.
- [x] Markdown in Assistant replies (#983, 2026-11-18). Models, Claude in
      particular, answer in Markdown, which the chat showed raw apart from a
      `**bold**` regex. Chosen approach, by surface: text that is only read
      (chat bubble, Assistant review notes and replies, character arcs) goes
      through `renderReplyMarkdown`, a second markdown-it instance with raw
      HTML off, images rendered as their alt text (a remote image would let a
      prompt injection make the browser fetch a URL carrying story text; the
      CSP has no `img-src`), and only http(s) and mailto links, opened in a
      new tab without a referrer. Text that becomes the writer's own gets
      prompt guidance instead (`prompts/format.ts`): coauthor, continuation
      and `suggest_edit` replacements ask for manuscript prose with italics
      only; summaries and enrich values ask for plain text. People's review
      comments still show as typed. A stripping backstop for short fields
      was left out until guidance proves not to be enough. Insert at cursor
      still copies the raw reply, since scene bodies are Markdown.
- [x] Staging review fixes for Phase 9 (2026-11-18). A fresh review of the
      whole staging diff found three things. The enrich queue is now created
      with pg-boss's `exclusive` policy: under the default policy a
      `singletonKey` does not stop a second job, so repeat `/enrich` or "Write
      arc" clicks each ran (and paid). A policy cannot change once a queue
      exists, which is why the older review and summaries queues are a
      separate issue. An arc is only stored if no story it read was muted
      while the model was writing (the job fails and its retry reads without
      that story), and muting plus clearing arcs is one transaction. A pending
      summary suggestion can no longer replace a summary the writer wrote
      after it was staged: the server refuses it, and the editor hides it
      while the summary field has text.

- [x] Muted stories stay out of universe-wide work (2026-11-18, #975). Mads
      decided a story mute should keep that book's prose from the model
      everywhere, not only hide the surfaces on it. One condition,
      `storyAssistantOn()` (`universe-scope.ts`: `llm_config` does not contain
      `enabled: false`), is added to every universe-wide read that feeds a
      model: `universeSkeleton` (the universe outline in context and
      `list_scenes`), the tools' `loadScene` (`get_scene` and the write tools),
      `search_text` (a new `assistant` option on `searchAll`), `find_appearances`
      and enrichment (a new `assistant` option on `entityAppearances`; the Plan
      page's "Appears in" list still shows every story), the enrichment
      candidate query, character arcs and their staleness, and the universe
      continuity pass. Muting a story also drops the stored arcs of the
      characters it mentions (`saveStoryLlmOverride`), since an arc written
      before the mute may retell it; an arc rewrite that finds no scenes left
      clears the old arc too.

- [x] Character arc summaries (2026-11-18, #846). Migration 0079 adds
      `characters.arc_summary_md` and `arc_summary_at` (additive; characters
      only, YAGNI for places and lore). `llm/arc-summary.ts`:
      `summariseCharacterArc` reads the live scenes in the character's universe
      that mention them, one per scene in reading order (story series position,
      then scene position), each as its `summary_md` or else the passage around
      the first mention, evenly sampled to 60 so a long arc keeps its opening and
      latest scene, and asks for at most five sentences (role `utility`, no
      tools). It writes the columns directly, stamping the database time the read
      started and keeping `updated_at`: generated metadata in its own column, the
      way scene summaries are, never the writer's summary. An empty reply throws
      and leaves the earlier arc. Stale (`arcIsStale`) when a mentioning scene's
      `updated_at` is after `arc_summary_at`; shown, never regenerated on view.
      The job shares the `assistant-enrich` queue (data carries `characterId`;
      singleton key `arc:<id>`; job kind `arc` in the activity center,
      job-status, and running-jobs) and notifies with the `assistant_enrich`
      kind, linking to the character. `POST /api/assistant/arc-job`; the
      "Arc across the stories" section in `EntityEditor` (characters, both Plan
      pages) waits on the job and refreshes the page data. Context assembly adds
      the arc to the character block ("Across the stories: ..."). Not in the
      export: it is regenerable Assistant output, not the writer's words, and
      nothing on the import side would read it back.

- [x] Background universe enrichment (2026-11-18, #845 part 2). The
      `assistant-enrich` queue (`ASSISTANT_ENRICH_QUEUE`), `queueAssistantEnrich`
      (singleton per universe, the shared Assistant send options), and the
      worker's `assistantEnrich` handler, which re-checks the owner and calls
      `enrichUniverse` (`llm/enrich.ts`). The pass picks the universe's
      characters, places, and lore that are mentioned in a live scene and either
      were never enriched or have a mentioning scene with `updated_at` after
      their new `assistant_enriched_at` (migration 0078, additive, one column per
      entity table). Each entity runs the same `enrichEntity` as the inline
      button at universe scope, metered against the account spend cap, and is
      marked with the database time its read started (preserving `updated_at`), so an edit
      during the pass is caught next time and a failed read is retried. Started
      by `/enrich` (scope both; a story focus runs over its universe) through
      `POST /api/assistant/enrich-job`; tracked as job kind `enrich` in the
      activity center, job-status, and running-jobs, and announced with a new
      `assistant_enrich` notification kind linking to the universe Plan.
      `decideEntitySuggestion` no longer queues the mention reindex itself (it
      returns the universe for the route to queue), so `entity-suggestions.ts`
      stays loadable by the worker, which cannot load `jobs.ts`.

- [x] Universe-scope entity enrichment (2026-11-18, #845 part 1). The
      enrich endpoint takes a `universeId` as well as a `storyId`, and the
      universe Plan entity editor now shows "Suggest details" and the pending
      suggestions (before, only the story Plan did). At universe scope the
      appearances are spread across stories (`spreadAppearances`: round-robin
      per story, returned in reading order) so the first story does not fill
      all 16 slots, and each passage is labelled with its story. The universe
      scope runs on the account settings (no story mute or model override to
      apply). `enrichEntity` reads the entity through `resolveOwnedEntity`
      rather than `getEntityCard`, which also loaded relationships it never
      used. Staging now drops what the writer rejected: an alias rejected in
      any case, and a detail rejected with the same label and value (a new
      value for that label can still come back). Summaries keep the old rule
      (only when none is set or pending).

Lookups per reply (2026-11-18, #990, PR #993): a universe chat question about
chapter lengths answered from part of a chapter because the per-reply tool-call
limit was a fixed 8 with no setting and no notice. The limit became an Account
field (default 20). It moved to a new stored key, `toolCallLimit`, written only
when the writer changes the box: the old `toolCallBudget` key had been written
on every save, so it only held the old default and could not tell a choice
from a default; a data migration was avoided because staging carries its own
migrations. Cut-short replies now carry a `stopped` frame and meta note. Review
found that hitting the limit exactly flagged every such reply as cut short, so
the loop now concludes only once the model asks for a call past the limit (at
the cost of one extra round in that case). Considered and left: a batched
`get_scene`, and dropping the minimal profile's halving (documented instead).

- [x] Step 1 - gateway plumbing (server-only, no surfaces). The
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
- [x] Step 3 (pulled ahead of the chat surface - it is pure backend) -
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
- [x] Assistant name + persona (author request - a bit of personality). A
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
- [x] Tools and data retrieval (author request - "get it all ready for the
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
- [x] Endpoint setup helpers (author request - non-tech-savvy setup). In
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
- [x] Tool-capability detection (finishes the tools work). The probe now sends
      a one-shot forced-optional tool request and reports `supportsTools` from
      whether a tool call comes back (best-effort: any error or a plain answer
      reads as no tools), alongside `supportsStreaming`. `probeAccountEndpoint`
      / `probeEndpoint` in `llm/models.ts` expose it so the setup screen can
      show a "tools: supported / not" line next to the discovered models; the
      flags are meant to be saved onto the config, and the gateway already
      withholds tools when `supportsTools` is false. Unit tests (tool call
      detected / rejected) + integration (capabilities reported, egress
      denial). UI deferred.
- [x] Account Assistant settings UI (first surface; design handed over by the
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
- [x] Chat surface + layout gate + per-story mute (second surface; branch
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
- [x] Admin egress panel (the SSRF control; branch
      `feat/assistant-egress-admin`). The admin "AI" section (a "soon" stub
      until now) becomes the egress policy form: a select over `block-private`
      (default, safe for shared instances) / `allowlist` / `open`, plus a hosts
      textarea (one per line) for the allowlist mode, wired through a `saveEgress`
      action over the existing `egressPolicy` / `saveEgressPolicy` helpers
      (`llm/egress.ts`). Plain-language labels, no admin help article needed
      (admin panel). The egress helpers are already unit- and integration-tested;
      the admin area 404s for the seeded regular-user e2e session, so no new e2e.
      Lint, check, and build pass locally.
- [x] Review surface, single-scene (third surface; branch
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
- [x] Whole-story / chapter background review (branch
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
- [x] Inline continuation (first inline surface; branch
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
- [x] Co-author (second inline surface; branch `feat/assistant-coauthor`). A
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
- [x] Recap / "catch me up" (first background-enrichment surface, sequencing
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
- [x] Summary maintenance (`assistant-summaries`, sequencing step 7; branch
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
- [x] Entity enrichment (sequencing step 7, the deferred suggestion machinery;
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
- [x] Provider presets + native Claude adapter + usage log (2026-06-12;
      PR #448, shipped as v3.8.0 with usage-log paging and per-provider
      help docs). First-class providers for the Assistant:
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
- [x] Genre and style notes on stories (2026-06-12; PR #450, shipped as
      v3.9.0 with the worker import fix, PR #451). A free-text "Genre and style" field on story
      settings (`stories.style_notes`, migration 0063) stating the genre and
      craft intent; `loadStoryScope` carries it and the assembled context
      frames it as the standard to judge the prose against, so Assistant
      reviews calibrate to the author's aim instead of a literary-fiction
      default. Alongside it, an "Established setting" toggle on universe
      settings (`universes.established_setting`, migration 0064) for stories
      set in published canons (Forgotten Realms, Azeroth): it switches the
      context preamble from "never invent beyond this material" to "you may
      draw on the setting's published canon, the writer's material overrides
      it", since the default grounding instruction actively forbids the canon
      knowledge that fan-fiction review needs. Help (reviewing.md) updated. The discovery half of the idea
      (genre tags and content tags on published editions, for a future
      instance-wide public library) was deliberately split off and parked in
      the roadmap under Phase 10; do not build the taxonomy before the
      discovery surface exists.
- [x] Per-role thinking and effort for the Claude provider (2026-06-12;
      PR #453, shipped as v3.10.0 with the codex-app/codex-worker image
      launchers, PR #454). A `tuning` map on the account llm_config
      (jsonb only) keyed by assistant role: a thinking toggle (sent as
      `thinking: {type: "adaptive"}`, omitted when off - an explicit "disabled"
      is rejected by models where thinking is always on) and an effort level
      (low/medium/high/xhigh/max, sent in `output_config`). Only the Anthropic
      adapter consumes it; the settings page shows the controls per role for
      the Claude provider only. Tool loops with thinking on echo the response's
      original content blocks verbatim (ChatMessage.raw, adapter-private),
      since the API requires thinking blocks unchanged ahead of their tool_use
      blocks. Partial saves keep the stored map; the models form save replaces
      it. Help (account.md) updated. A 1M-context toggle was considered and
      dropped: on current models the large window simply is the context window,
      no request field exists. Same branch: prompt caching for the Claude
      adapter - a cache_control marker on the system block (covers tools +
      persona + world context) and on the last user block (each round of a
      tool loop reuses everything sent so far); markers are unconditional
      since a too-short prefix is silently not cached, and assistant turns
      are never marked (replayed thinking blocks must stay unchanged). Usage
      rows count cache reads and writes into the prompt total, so estimates
      err high rather than low.

- [x] Review focuses and the full story review (2026-06-12; PR #457,
      shipped as v3.11.0 with the get_scene cap fix, PR #456). The scene Assistant submenu offers five passes:
      quick notes (the old sparing default), spelling/grammar, prose/style,
      entities/lore, and a full copyedit; the focused passes enumerate their
      categories and forbid filtering for importance, since a model told to
      be sparing finds the small errors and then declines to report them.
      The story-settings review now runs the full pass per scene and ends
      with a cross-scene consistency run (one request that reads every scene
      via get_scene and reports only issues that span scenes: name/timeline
      drift, idiom conventions, recurring tics). Exhaustive passes carry a
      server-set tool budget (64 per scene; 2n+24 for the consistency pass,
      gateway ceiling 200) since each note is one tool call and the account
      default of 8 starved them. Help (reviewing.md) updated.

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

Pattern notes and pattern passes (#1131, #1132, #1136, #1137,
staging/pattern-passes, 2026-11-19). A pattern note is one Assistant review
thread whose edits carry `pattern_thread_id` (migration 0088, additive, `on
delete set null`), so a habit that repeats across scenes is one note with many
linked edits rather than a note per scene (#1131). The guided pass (#1132)
walks the note's pending edits in reading order; after each accept the
Assistant re-reads the changed paragraph and one either side and may stage one
follow-up there, which becomes the next step. The re-read returns the ids it
staged, since telling follow-ups apart by "not in the queue at the start"
also caught edits from a review still running and showed the follow-up one
step late. An accept first saves the open editor; typing inside the marked
words makes the accept refuse rather than overwrite it (`createSuggestion`
and `decideSuggestion` re-read the body under the revision lock). The
chapter pass (#1136) surveys each chapter once for up to 5 habits, then asks
for suggest_edit fixes one scene at a time, in at most 25 scenes per pattern
to bound cost; the scene reviews get the open notes so they do not repeat
them. The whole-book pass (#1137) sends the book in one request when it fits
in 80% of the context window after the reply allowance, else falls back to
chapter by chapter, carrying the top 20 known patterns forward. A retry of
the survey relies on the Anthropic adapter's existing cache on the last user
block rather than new caching. The pass is skipped when the endpoint cannot
call tools, and stops asking for a pattern's fixes once its note is resolved
or cleared mid-run. Three staging review rounds (#1187, #1191, and round 3)
fixed stale-range accepts, resume state, the spend cap and the step order;
the low findings left were filed as issues.

Several Assistant chats per story (#985, 2026-11-18): asked for alongside
#984, modelled on the session picker in Claude Code for VS Code. Each scope
(story or universe) and user had one transcript; now `assistant_chats` holds
any number, and turns and summaries carry a `chat_id`. The turns keep their
story_id / universe_id as well, so the scope-wide deletes and the split
proposal lookup did not change. Migration 0080 adds the column nullable,
backfills one chat per old conversation titled from its first user turn
(the same rule as `chatTitle`, in SQL; Mads approved the one-time rewrite),
drops summaries with no turns left, then sets NOT NULL; an integration test
seeds a database at 0079 and runs it through. A new chat is created by the
server on its first message rather than by the browser, so an abandoned "New
chat" leaves nothing behind and no client-chosen ids are trusted; the id comes
back as `x-chat-id`. Search is over titles in the browser, since one scope's
list is short. `/clear` became `/new` (the old name still works) because
clearing no longer deletes. Left out until asked: renaming chats, deleting
from the list itself, a cap on chats per scope.

Drag-to-resize side columns (#984, 2026-11-18): the follow-up #733 deferred,
asked for so long Assistant chats get more room. Mads chose one right-column
width for every tab rather than a wider one only while the Assistant is open.
`PaneResizer.svelte` overrides `--left-w` / `--right-w` on the root element, so
every reader of the tokens (including the settings shell) follows, and the
value is a CSS `clamp(floor, chosen, cap-vw)` so a width picked on a big screen
still fits a smaller one. localStorage holds that exact string and the app.html
pre-paint script applies it after a strict regex check, so there is no flash
and no way to inject other CSS. Per browser rather than per account: a width
that suits one screen rarely suits another. The handle lives inside the aside
(axe's region rule flags content outside landmarks) but is positioned against
the `.body`, which keeps it out of the pane's scroll and clip. Hidden under
960px, where panes are tabs or scroll sideways.

Running Assistant jobs after a reload (#963, 2026-11-18): the activity center
and the review modal only knew a job id they had started, so a reload lost
every running review. Options were discussed on the issue; Mads picked the
activity center restored on load plus a progress line on the story. `GET
/api/assistant/jobs` lists the writer's unsettled review and summary jobs
(a direct query on `pgboss.job` by `data.userId` and the created, retry and
active states, named from the writer's live stories and universes; pg-boss's
`findJobs` has no state filter and returns the oldest rows first, capped, so a
busy writer's running job could fall past the cap); the root layout resumes
`trackJob` for each. `trackJob` now keeps a `trackedJobs` list (job, scope,
latest progress) apart from the cards, so dismissing a card does not hide the
run, and `RunningJobsNote` under `ModeSwitcher` reads it. The 15-minute give-up
in `trackJob` went: a story review can run for hours, so polling slows to 15s
after five minutes instead, stops on a 401, 403 or 404 (signed out), and a run
the queue dropped (`stale`) now ends the card as stopped rather than spinning. Universe continuity passes show only as
a card; a universe-page line was left out until asked for. Follow-up (#970):
the layout re-checks the list when a tab comes back into view (at most every
10s, `watchRunningJobs`), so a job started in another open tab shows there too;
`trackJob`'s dedupe keeps a job already followed from getting a second card.

From the design pass click-throughs (2026-07-30):

- [x] Quick note capture while writing. Switching to the Notes tab (or
      mode) to jot something down is cumbersome and takes you away from the
      text. Wanted: a "quick note" affordance that floats over whatever you
      are doing - a small corner card or overlay, likely on a shortcut -
      that saves to the story's notes (attached to the open scene when
      there is one) without moving focus away from the editor for more
      than the jot itself. Design it in a later pass; not part of the
      Session 3 port. Shipped in v3.17.0 (#515).
- [x] Ask for a pen name when publishing. The reading pages name the
      author by pen name, falling back to the account's display name
      (Session 3 port). An author publishing pseudonymously whose display
      name is their real name would be named on the public page without
      realising. When a story is published (or a handle claimed) and the
      account has no pen name, ask for one - offering the display name as
      the default - so the fallback is always a choice the author made.
      Shipped in v3.17.0 (#517).

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
