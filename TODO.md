# TODO

Working checklist against `scratch/system-design/roadmap.md`. One roadmap step
per line; details live in the roadmap. Cross off as things merge to main.
Notes on how shipped work was built go in `scratch/system-design/history.md`,
not here.

## Open

Next up (as of 2026-10-20, after v3.20.0). Nothing is in flight; pick from:

- [ ] Phase 9 leftovers: whole-universe background enrichment and character
      arc summaries (see Phase 9 below).
- [ ] Capability review leftovers (roadmap "Next-phase candidates"): duplicate
      a whole story, cross-container moves between stories and universes, a
      side-by-side draft comparison, and real front and back matter. Each
      needs a scoping conversation first.
- [ ] Feedback backlog items still open (see the end of this file): review
      toolbar for bulk decisions, magic-link sign-in, sign-up note for
      approval mode, public library, instance role, offline desktop app.
- [ ] Phase 10 (roadmap): public landing pages at `/@handle/<slug>`, genre and
      content tags, quota enforcement.

## Review follow-ups

From the 2026-10-19 codebase review (see history.md for the full round):

- [ ] The worker's purge schedules have no test.
- [ ] `resolvePlanEntity` still queries the three entity tables in turn (#623).
- [ ] End-to-end CI still retries twice, which hides flaky tests (#621).

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
- [x] 17. Universe editor (v1.3): universe-scoped Plan view, no "In this book" without a story, dashboard...
- [x] 18. Entity relationships (v1.4): relation_types + entity_relationships schema (story_id and custom...
- [x] 19. Outline tree (v1.5): outline_nodes schema, Outline group atop the story Plan sidebar (drag...
- [x] 20. Declared story membership: membership tables, story Plan lists members-or-mentioned...
- [x] 21. Entity autocomplete (v1.6): completion source over names and aliases, popup and ghost-text...

> Phase 3 complete: v1.0 shipped after step 15 (gated on the full code
> review; findings fixed, leftovers in the backlog below), then v1.1
> through v1.6 in turn. Next is Phase 4 (history, polish, import/export),
> steps 22-27, releasing as v2.0. The author holds 3 free /code-review
> ultra runs, intended for phase boundaries.

Notes on the shipped steps: [history.md](scratch/system-design/history.md#phase-3---worldbuilding).

## Phase 4 - History, polish, import/export

- [x] 22. Revisions and history (v1.7): polymorphic revisions table, insert on body-changing saves across...
- [x] 23. TODO markers (v1.9): scene_markers schema, TODO: line detection shared by editor and panel...
- [x] 23b. Editable continuous view (v1.10): the story view stitches one SceneEditor per scene (own...
- [x] 24. Scheduled off-site backups and restore (v1.8, cadence in v1.8.1): hourly pg_dump from the... (#682)
- [x] 25. Assets and images (v1.11): S3-compatible storage as the only backend (author's call: a database...
- [x] 26. Markdown, EPUB, and PDF export (v1.12): shared markdown-it renderer (raw HTML escaped), zip of...
- [x] 27. Public reading pages, self-host (v2.0 candidate): publications table, publish freezes editions...

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

Notes on the shipped steps: [history.md](scratch/system-design/history.md#phase-4---history-polish-importexport).

## Phase 5 - Account lifecycle and hosted launch

- [x] 27b. Harden the admin bootstrap CLI (v2.0.1).
- [x] 28. Sign-up page (v2.1): /signup creates an unverified, unapproved user, issues an email_verify...
- [x] 29. Email verification flow (v2.1): /verify-email consumes the single-use token and sets...
- [x] 30. Password reset flow (v2.2): /forgot-password issues a 1h password_reset token and emails the...
- [x] 31. Admin approval UI (v2.3): /admin lists pending accounts (name, email, sign-up time...
- [x] 31c. SMTP relay configuration (v2.4.2): an Email relay section in the admin panel sets...
- [x] 31b. Site admin panel (v2.4.1): /admin is now a proper panel with all site administration gathered...
- [x] 32. Account self-service. (v2.4.5, v2.4.3, v2.4.4)
- [x] Design adaptation (author's design in scratch/app-design/new_admin/, handed over 2026-06-04). (#5)
- [x] 32b. TOTP two-factor, in the /account Security section.
- [x] 33. Operational essentials + cross-user isolation audit.
- [x] 34 + 35. Dropped (2026-06-04): the hosted service is one shared instance (GitHub model), not a...
- [x] In-app help (/docs).

> Phase 5 complete; shipped as v2.5.0 (2026-06-04). The held v2.5 review
> (ultrareview) found six issues - single-use TOTP/replay, password re-auth on
> 2FA disable/regenerate, one-shot enrolment confirm, an avatar-upload race, a
> reverting theme toggle, and a duplicate-link crash on /@handle - all fixed
> before the tag (migration 0024 adds user_totp.last_used_step). Post-v2.5 the
> roadmap's candidate pool was regrouped into themed phases 6-10 + future
> (2026-06-04); the entity quick details (jsonb) + full-fidelity history pair
> landed in Phase 7. One free /code-review ultra run remains.

Notes on the shipped steps: [history.md](scratch/system-design/history.md#phase-5---account-lifecycle-and-hosted-launch).

## Phase 6 - Backend and access

- [x] Invite codes: invite_codes table (migration 0026), admin mints codes in Users & access (label... (#107)
- [x] Stored export artifacts: export_artifacts table (migration 0027), the worker generates markdown... (#109)
- [x] Passkeys: webauthn_credentials as designed (migration 0028), crypto via @simplewebauthn/server... (#111)
- [x] Guest review (comments, then suggested edits) - [x] Stage 1 - invitations and threaded comments... (v2.9.0)

> Phase 6 complete (2026-06-05), shipped as v2.6.0 (invite codes + stored
> exports), v2.7.0 (passkeys), v2.8.0 (review comments), and v2.9.0 (suggested
> edits). WAL/PITR stays parked per the roadmap's own criterion. Next up when
> work resumes: Phase 7 (writing and planning).

Notes on the shipped steps: [history.md](scratch/system-design/history.md#phase-6---backend-and-access).

## Phase 7 - Writing and planning

- [x] Entity quick details + full-fidelity entity history: details jsonb on characters/places/lore... (#117)
- [x] Preference layering: stories.preferences jsonb (migration 0032), storyPreferences merges the user's... (#121)
- [x] Rich editing mode + markdown affordances: markdown styles in place in every prose editor... (#122)
- [x] Page setup for print/PDF: page_setup jsonb on users (account defaults) and stories (per-key... (#124)
- [x] Spell-check: browser-native squiggles behind a spellCheck preference (default on) with a... (#126)
- [x] Library and story-settings styling: the library becomes a designed page (topbar, universe cards... (#128)
- [x] Command palette (Ctrl+K): owner-scoped fuzzy search over universes/stories/scenes/entities (aliases... (#129)
- [x] Mention disambiguation: deterministic attribution for shared names (pin > story members > character... (#130)
- [x] Perf debts ride-along: tooltip reads the decoration set; applySceneOrder and updateMarkerAnchors... (#127)

> Phase 7 complete (2026-06-05), shipped as v2.10.0 (quick details + entity
> history), v2.11.0 (preference layering + rich editing), v2.12.0 (page
> setup), and v2.13.0 (spell-check, library and settings styling, command
> palette, mention disambiguation, perf debts). Next up when work resumes:
> Phase 8 (overviews and visualization).

Notes on the shipped steps: [history.md](scratch/system-design/history.md#phase-7---writing-and-planning).

## Phase 8 - Overviews and visualization

- [x] Universe Insights view: a new view at universe scope (sidebar seg next to Plan, palette command) on... (#132, v2.14.0)
- [x] Scene cards board: the story Plan's centre shows the scenes as cards in status lanes... (#134, v2.15.0)
- [x] Relationship web view: force-directed graph of entity_relationships (d3-force simulation run... (#136, v2.16.0)
- [x] Editor selection menu (author request, 2026-06-05): select a phrase and right-click for quick... (#137, v2.16.0)

- [x] Public face (author request, 2026-06-05): a landing page at / for signed-out visitors (ported from... (v2.17.0)

- [x] Universe settings restyle + URL slugs (author requests, 2026-06-05): /universes/[id] joins the... (v2.18.0, #141, #142)

- [x] Slug edge fixes from the v2.18.0 self-review (2026-06-06): plan create-entity actions redirect back... (#144, v2.18.1)

> Phase 8 complete (2026-06-05), shipped as v2.14.0 (Insights: heatmap +
> progress dashboard), v2.15.0 (scene cards board), and v2.16.0
> (relationship web + editor selection menu). The timeline view stays
> parked on the world-calendar design, and plotlines/arcs on usage
> evidence, per the roadmap's own criteria. Next up when work resumes:
> Phase 9 (AI and interop) - or the timeline's calendar design talk,
> whichever the author wants first.

Notes on the shipped steps: [history.md](scratch/system-design/history.md#phase-8---overviews-and-visualization).

## Phase 9 - The Assistant (LLM)

- [x] Step 1 - gateway plumbing (server-only, no surfaces).
- [x] Step 3 (pulled ahead of the chat surface - it is pure backend) - context assembly.
- [x] Assistant name + persona (author request - a bit of personality).
- [x] Tools and data retrieval (author request - "get it all ready for the front-end").
- [x] Endpoint setup helpers (author request - non-tech-savvy setup).
- [x] Tool-capability detection (finishes the tools work).
- [x] Account Assistant settings UI (first surface; design handed over by the author as a standalone HTML mock).
- [x] Chat surface + layout gate + per-story mute (second surface; branch `feat/assistant-chat`).
- [x] Admin egress panel (the SSRF control; branch `feat/assistant-egress-admin`).
- [x] Review surface, single-scene (third surface; branch `feat/assistant-review-scene`).
- [x] Whole-story / chapter background review (branch `feat/assistant-review-jobs`).
- [x] Inline continuation (first inline surface; branch `feat/assistant-continuation`).
- [x] Co-author (second inline surface; branch `feat/assistant-coauthor`).
- [x] Recap / "catch me up" (first background-enrichment surface, sequencing step 7; branch `feat/assistant-recap`).
- [x] Summary maintenance (`assistant-summaries`, sequencing step 7; branch `feat/assistant-summaries`).
- [x] Entity enrichment (sequencing step 7, the deferred suggestion machinery; branch...
- [x] Provider presets + native Claude adapter + usage log (2026-06-12; PR #448, shipped as v3.8.0 with...
- [x] Genre and style notes on stories (2026-06-12; PR #450, shipped as v3.9.0 with the worker import fix, PR #451).
- [x] Per-role thinking and effort for the Claude provider (2026-06-12; PR #453, shipped as v3.10.0 with... (#454)

- [x] Review focuses and the full story review (2026-06-12; PR #457, shipped as v3.11.0 with the... (#456)

Notes on the shipped steps: [history.md](scratch/system-design/history.md#phase-9---the-assistant-llm).

## Capability review follow-ups (2026-06-06)

- [x] 1. Chapter management + scene delete. (#147, v2.19.0)
- [x] 2. Find/replace + full-text prose search. (#151, v2.20.0)

Notes on the shipped steps: [history.md](scratch/system-design/history.md#capability-review-follow-ups-2026-06-06).

## Design alignment (author feedback, 2026-06-06)

- [x] Library dashboard (dashboard.html): page header with totals and a New universe button, Recent row... (#154, v2.21.0, #153)
- [x] Universe settings (universe.html): header eyebrow + title, Contents stat tiles, an Entity... (#156, v2.22.0)

- [x] Session pane + plan flow fixes (author feedback, 2026-06-06): the Insights segment navigated away... (#160, v2.23.0)

Notes on the shipped steps: [history.md](scratch/system-design/history.md#design-alignment-author-feedback-2026-06-06).

## Click-through feedback (2026-06-06)

- [x] Bugs: a reload inside the autosave debounce dropped a scene rename for good (pagehide keepalive... (#162)
- [x] Quick wins: opening a story resumes the last-edited scene; palette gained a Focus mode toggle and... (#163, v2.24.0)
- [x] Editor design alignment: mention autocomplete popup per the prototype (coloured badges, kind... (#165, v2.25.0)
- [x] Plan-page alignment: both plan pages keep the same Reference/History/Session pills with an... (#167, v2.26.0)
- [x] Preferences and left-menu search: a "Writing streak" preference under Editor behaviour hides the... (#169)
- [x] Rename propagation (follow-up feedback): renaming an entity now offers - once the rename settles... (#170, v2.27.0)

Notes on the shipped steps: [history.md](scratch/system-design/history.md#click-through-feedback-2026-06-06).

## Issue review round (2026-10-26)

Staging branch `staging/issue-review`, merged to main in one PR.

- [x] Accessibility: account menu focus, focus trap and restore in modals, shared menu keyboard behaviour, WCAG AA contrast in every theme, named controls, skip link and page landmarks, branded error pages. (#720, #722, #723, #721, #725, #726, #724)
- [x] Layout: side columns grow on wide screens, settings column anchored next to the sidebar (step 1 of #731), narrow app bar, help and library. (#733, #731, #727)
- [x] Library and plan: tinted placeholder covers, library view setting (covers, no covers, table), one Add row per Plan sidebar group. (#728, #738, #729)
- [x] Controls: theme picker in the account menu, app confirm prompt, view menu name, password hint, no explanatory notes under side panels. (#732, #730, #734)
- [x] Platform: Node 26, HSTS from the configured ORIGIN, SvelteKit 3 and adapter-node 6. (#616, #613)
- [x] Hygiene: action errors mapped by code, one display locale (en-GB), typed link helper, shipped-work notes moved to history.md. (#627, #735, #736, #630)

Follow-ups: all handled in the 2026-10-29 round below (#769 closed as not
planned).

Notes on the shipped steps: [history.md](scratch/system-design/history.md#issue-review-round-2026-10-26).

## Issue review round (2026-10-29)

Staging branch `staging/issue-review-2`, merged to main in one PR.

- [x] Flaky core-flow e2e: own user, unique names, wait for the scene data before typing. (#760)
- [x] Status, danger and author colours used as text pass AA in every theme (ink twins). (#744)
- [x] Server-rendered times use the author's timezone (`codex-tz` cookie). (#766)
- [x] Settings rows and "On this page" links for Security and Assistant, steps 2 and 3. (#731)
- [x] Story workspace shows one pane at a time below 820px. (#737)
- [x] SvelteKit 3 cleanup: `refreshAll`, `Response.json`, `snapshot()`, `#lib` subpath imports. (#752)
- [x] No typing into a scene while the next one opens, a split or merge runs, or a failed save holds a switch. (#772)
- [x] Review leftovers: backup scripts load under plain node, save requests time out, real-cookie timezone test, `#lib` loader and lint messages. (#786, #787, #788, #789)

Follow-ups (open):

- [ ] Entity badge letter contrast (#775).
- [ ] Focused review mark tint contrast (#776).

Notes on the shipped steps: [history.md](scratch/system-design/history.md#issue-review-round-2026-10-29).

## Feedback backlog

From the design pass click-throughs (2026-07-30):

- [x] Quick note capture while writing. (v3.17.0, #515)
- [ ] A review toolbar for bulk decisions. "Accept all" was removed
      (2026-07-30): applying every pending edit at once can change far
      more than is on screen. If bulk accept/reject comes back, it
      belongs in a purpose-built review toolbar that shows what it is
      about to do, not a single button above the cards.
- [x] Ask for a pen name when publishing. (v3.17.0, #517)
- [ ] Magic-link sign-in as a secondary option (2026-07-30). The public
      surfaces design proposed "Send me a sign-in link instead" under the
      password field. It did not ship: there is no backend for it, and the
      owner does not want it primary, because a link in an inbox defeats a
      password manager. If it comes back it is a secondary route beside the
      password and the passkey, and it needs the token, the mail, and the
      rate limiting to go with it.
- [ ] Sign-up "What are you working on?" note for approval mode
      (2026-07-30). The design put a one-line textarea on the sign-up form
      with the hint that a person reads it, which is true and worth saying.
      It did not ship: storing it needs an additive migration, and it is
      only useful if the admin approval panel shows it beside the account
      it belongs to. Both halves or neither.
- [ ] A public searchable library of published stories (2026-07-30), the
      way Archive of Our Own works: browse and search what people have
      published, rather than needing an author's handle or a direct link.
      Service-only - a self-hosted Codex has nothing to index but its own
      handful of accounts - so it belongs with the instance-role setting
      below. Today's design deliberately has no site-wide directory (see
      design.md), so this is a design decision to make, not just a feature
      to build. Its own pass.
- [ ] An "instance role" setting (2026-07-30), personal or managed
      service, alongside the sign-up mode in app_settings. It would decide
      how the landing page presents itself: a private self-hosted Codex
      could show a quieter door, hero and sign-in only, while the managed
      service shows the full pitch. It also gates copy only the service
      can honestly say - "let us run it for you", pricing, how long
      approval takes - and it is the natural anchor for the public library
      above, which is service-only. Not to build now; recorded so the
      landing work does not have to be redone when the service exists.
- [ ] A standalone offline desktop app (2026-07-30), probably Electron:
      run the built SvelteKit server locally against PGlite, which Drizzle
      supports, so the Postgres schema and queries carry over unchanged;
      assets on the filesystem instead of S3; background jobs in-process
      instead of pg-boss. No sign-in, no accounts and no email at all
      locally - your Codex lives on this machine. Signing in would only
      matter for a later feature that connects the desktop app to a hosted
      Codex and syncs when the network comes back (writing through a
      flight, reconciling on landing), and that sync is the hard design
      problem, its own pass. Not roadmap work now.

From first real use (2026-06-03):

- [x] Scene marks in the continuous view should be hideable: shipped with v1.10 (continuousSceneMarks preference)
- [x] Editable continuous view: shipped with v1.10 (roadmap step 23b)
- [x] Spell-check from a user language preference (Phase 7; browser-native first). (#126)
- [x] Markdown affordances: the shared renderer shipped with v1.12 (exports + print); reading pages pick...
- [x] Preference layering: user-level preferences with per-story overrides merged at render time (same...
- [x] Default editing format preference (Phase 7; reordered there on 2026-06-04).
- [x] Entity colours with meaning: shipped with v1.2 (characters/places join categories; badge takes the...

From the pre-v1.0 code review (2026-06-03); the four fixable findings were fixed:

- [x] Page setup for print/PDF (Phase 7, alongside preference layering): page size incl. book trim sizes...
- [x] Mention attribution is first-match when two entities share an identical name or alias; needs a... (#130)
- [x] Hover tooltip re-runs full-document detection per hover; read from the existing decoration set... (#127)
- [x] applySceneOrder issues one UPDATE per scene; batch into a single statement when stories grow (scene-order.ts). (#127)
- [x] updateMarkerAnchors issues one UPDATE per anchor in a loop; batch it the same way (markers.ts). (#127)

From a pre-v2.0 self-review (2026-06-04); the cover IDOR and the duplicated media-types map were fixed:

- [x] The worker-indexed find-usages e2e assertion was timing-flaky on loaded CI runners. (v2.0.1)
- [x] Worker job enqueue is best-effort and silently drops on failure (jobs.ts), so a dropped mention...
- [x] Entity History is body-only: changing an alias or relationship records no revision, and Restore... (#117)
- [x] CI never ran the Docker image, so a broken worker import closure shipped silently (caught by hand... (v1.6.1)

Notes on the shipped steps: [history.md](scratch/system-design/history.md#feedback-backlog).
