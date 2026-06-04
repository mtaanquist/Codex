# Codex - build roadmap

Phased sequence for building the app. Each phase ends with something usable; nothing is blocked on future phases. Read `design.md` and `schema.md` first.

Codex ships in two shapes from the same codebase: a self-hosted Docker image anyone can run, and a hosted service run by the project maintainer, which is that same image running as one shared instance with sign-up open on it (the GitHub model: your work scoped to you, published pages public). There is no fleet and no instance-per-user. The roadmap targets self-host first because the operator and the first user are the same person; the hosted launch lands once the writing experience is real enough to be worth opening up.

## Phases and versions

Phases describe **build sequence**: what depends on what, and in what order things should be done. Versions describe **shipping milestones**: when the product is worth declaring "usable enough" for you, or a friend, to actually start writing in. They are orthogonal: you can ship multiple times within a single phase, and a phase boundary does not have to be a version boundary.

For a solo project with no external deadline, small and frequent versioning is healthier than waiting for a phase to complete. The target milestones below are markers for when it makes sense to pause, tidy up, invite someone new to try it, and start the next thing.

- **v0.1** - end of Phase 1. Logs in, sees your name. Proves deployment works; nothing else does. Self-host only; admin approves new users via SQL.
- **v0.5** - end of Phase 2. Can create a universe, create a story, draft prose in scenes, read the story back as one continuous document, and come back tomorrow. Minimal but genuinely usable.
- **v1.0** - step 15. The first version you would actually want to write a book in: universes and stories and scenes, plus characters with mentions that underline names in the prose and "find usages" panels that make the mention index visible. Drops cleanly between Phase 3's character work and its places-and-lore work. Mentions are the piece that distinguishes Codex from a Scrivener clone, so shipping before they are in would undersell the tool.
- **v1.x** - incremental additions through the rest of Phase 3: places, lore, universe editor, relationships, outline, declared membership, autocomplete. Each ships independently when it feels done. By the end of Phase 3, you are on something like v1.6.
- **v2.0** - end of Phase 4. History timeline and diffs real, TODO markers in, images and covers in, markdown and EPUB export getting your words out cleanly, and public reading pages live on self-host. The v1 design realised for self-hosters, sans AI.
- **v2.5** - end of Phase 5. Account lifecycle real (proper sign-up, email verification, password reset, admin approval UI, account self-service). Operational basics in place (transactional email, basic rate-limiting, a cross-user isolation audit of the shared instance; off-host backups shipped back in v1.8). Authors can share work at a public `/@handle`. The one shared instance can open to invited friends; no fleet to provision.
- **v2.x and beyond** - anything from the Phase 6 onward candidates that survives contact with real use. After v2.5 the remaining work is grouped into themed phases (6: backend and access, 7: writing and planning, 8: overviews, 9: AI and interop, 10: monetization, then a deferred-hard "future" tier). AI integration lives in Phase 9 rather than at a reserved version number, and is explicitly not scheduled.

A rough rule for when to bump a version number: anything a user would notice, even a friend using the tool for the first time, is a version bump. Bug fixes are not. The numbers are for you to feel progress; the discipline is in not skipping them.

## Phase 1 - Foundations

Get the skeleton breathing. At the end, you can log in and see your own data.

1. Scaffold a SvelteKit app in TypeScript with `adapter-node`. Verify it runs. Stand up the test harness in the same step so it exists from the first commit: Vitest for unit and integration tests, Playwright for end-to-end, an `npm test` script, and one trivial test of each kind to prove the pipeline. The integration tests want a throwaway test database; point them at one (a separate `codex_test` database the setup runs migrations against) once Drizzle lands in step 2, and add the first real query test there.
2. Add Drizzle with the `node-postgres` driver, pointed at Postgres. Define the `users` table and generate the first migration.
3. Add `Dockerfile` and `compose.yaml` (app, a worker stub, `postgres:18-alpine`, and Caddy) plus a `compose.dev.yaml` with just the database for editor-hosted dev. The worker is a near-empty pg-boss process for now; real jobs arrive in later phases.
4. Run the stack in Docker end to end to prove the pipeline works.
5. Build sign-in: a session cookie backed by a revocable `sessions` row, issued after a password check (argon2 or bcrypt), with `display_name`, `role`, `approved_at`, and `email_verified_at` on `users`, plus `auth_tokens` for email verification and password reset. Block sign-in unless both `approved_at` and `email_verified_at` are set. A server hook guards protected routes.
6. Seed one admin user via raw SQL. Verify you can sign in, see your name, and that unapproved users are blocked.

> **-> v0.1 ships.** Deployment and auth proven. Nothing useful works yet beyond signing in.

## Phase 2 - Core content

Prove the writing loop. At the end, you can draft a novel in the tool, even if it is rough.

7. Add `universes`, `stories` tables and Drizzle models. CRUD pages: create universe, create story, list stories, open a story.
8. Scaffolded shell layout: top bar plus three columns plus CSS tokens. Port the prototype HTML and CSS into Svelte components with scoped styles. Brand and breadcrumb both clickable for navigation.
9. Focus-mode button wired up (toggle a class on `<body>`, `visibility: hidden` on sidebars so the prose does not shift). This is the first real piece of client state.
10. Add `chapters`, `scenes` with the schema as spec'd. Left sidebar shows the scene tree. Click a scene to open it.
11. Integrate CodeMirror 6 in the editor component. Debounced autosave posts to a server endpoint. Orphan-scene support verified. Wrap swappable extensions (future autocomplete, mentions) in a CodeMirror `Compartment` from day one.
12. Drag-to-reorder scenes in the sidebar (SortableJS or a Svelte drag library). Persist `global_position` and `position_in_chapter`.
12b. Continuous story view, read-only ("12b" keeps the step numbers below stable). A Write-view toggle renders the whole story as one document: scenes flow in `global_position` order with chapter titles as section headings, sidebar rows jump-scroll to their section, and clicking into a scene returns to the scene-at-a-time editor. Pulled forward from the Phase 6 candidates on author feedback; `global_position` was designed for it, so it is a rendering addition only. Editing inside the continuous view stays deferred.

> **-> v0.5 ships.** You can draft a book in the tool and read it back as one continuous document. No entities, no AI, no history, no outline, but the core writing loop works, and that is the hardest part.

## Phase 3 - Worldbuilding

Build one entity type fully, copy the pattern. At the end, the planning view is substantive.

13. Characters: schema, CRUD UI in the Plan view (at story scope), `character_story_notes` overlay, aliases, summary/body fields.
14. Entity mentions index. Debounced rebuild on scene save, run in the worker. Decorations in CodeMirror showing underlined names. Hover tooltips. The underline and tooltip extensions go in their own compartment so the "Underline known entities" setting can toggle them at runtime.
15. "Find usages" / "Appears in" panels. Click a mention, jump to scene; click an entity, see every mention.

> **-> v1.0 ships.** Characters work, mentions underline live in prose, find-usages closes the loop. This is the first version worth calling "ready to write a real book in." Everything from here on is addition.

16. Places and lore entries. Same pattern as characters. `lore_entries.keywords` powers in-editor search and feeds mention detection; `activation_mode` is modelled but unused in v1 (it is reserved for the eventual LLM context-injection feature, mirroring SillyTavern's lorebook semantics).
17. Universe editor. Plan and Notes views at universe scope, reusing the entity editor component from step 13. Hide story-scoped fields (the "In this book" overlay) when there is no story context. Route the dashboard's universe card click to this editor; the universe-settings gear still points at the universe settings page as before. Mostly a scope parameter and a filter query, not a new UI implementation.
18. Entity relationships. `relation_types` and `entity_relationships` schema. Seed built-in relation types (parent_of, sibling_of, spouse_of, friend_of, rival_of, enemy_of, ally_of, mentor_of, serves, born_in, raised_in, lives_in, rules, exiled_from, part_of) via migration. Relationships section in the entity editor with typed picker + target autocomplete + optional notes. Right sidebar shows relationships in a panel distinct from the mention-derived "Also appears near" panel. Directional relations render with the inverse label on the target's page; symmetric relations render the same on both sides.
19. Outline tree. Drag-and-drop. Optional linking of outline nodes to scenes/chapters.
20. Declared story membership (manual only). "Alice appears in this story" UI action.
21. Entity autocomplete. Completion source built on the mention index. Two render modes, both reconfigurable at runtime via a CodeMirror Compartment: inline ghost-text (Tab to accept, unambiguous matches only) and popup dropdown. User preference chosen via the three-option select in Display settings, also surfaced in the Session tab's quick settings.

> **-> v1.x releases throughout.** Each step from 16 onward is worth a minor version bump as it ships: v1.1 places, v1.2 lore, v1.3 universe editor, v1.4 relationships, v1.5 outline, v1.6 autocomplete. By the end of Phase 3 you are on something like v1.6 with full worldbuilding.

## Phase 4 - History, polish, import/export

Stabilise what is there. At the end, v1 is done and you can confidently use the tool for real work.

22. `revisions` table polymorphic over entity type. Insert on every debounced save. Per-item History tab in the right sidebar shows the timeline for whatever is currently open. Per-story and per-universe History sections in their respective settings pages show broader timelines. Manual checkpoints supported with optional labels. Preview banner in the centre column; Restore creates a new revision on top (never overwrites). A diff view compares any two revisions and shows a previewed revision against the current text; the same component is reused later for review suggestions.
23. TODO markers. `scene_markers` table plus editor support: flag a selection or a line beginning `TODO:`, see it highlighted in the prose and listed in a per-story panel, and check it off when done. Small and self-contained, so it can ship as a v1.x point release rather than waiting for the rest of Phase 4.
23b. Editable continuous view. Extend the continuous story view (step 12b) so prose is editable in place: stitched per-scene editors, each autosaving separately, with focus and scroll handled across boundaries. Includes a display preference for whether scene marks render inside the flow at all, since some authors treat scenes as atomic splits rather than part of the reading flow. Promoted from the Phase 6 candidates on author feedback; ships as a v1.x point release so it lands well before v2.0.
24. Scheduled off-site backups and restore (took over this slot on 2026-06-04 when the SillyTavern import moved to the Phase 6 candidates; pulled forward from step 33 because a tool holding someone's novel is not production ready without disaster recovery). Hourly pg_dump from the worker to any S3-compatible bucket (S3, B2, MinIO, R2), skipping uploads when nothing changed; tiered retention (everything recent, then newest per day); an admin ad-hoc trigger with visible run history; and a documented, drilled restore script. Shipped as v1.8, cadence and tiering as v1.8.1.
25. Assets and images. `assets` table with S3-compatible storage as the only backend (decided 2026-06-04, replacing the planned local-disk option: a database restore then keeps every asset link valid, and disaster recovery stays one story). A separate bucket or prefix from the backups; off until ASSET_S3_* is configured, with an optional MinIO compose profile as the batteries-included local bucket. Upload, drop, and paste images in the editor and insert them as markdown pointing at an app-served path. Story cover image, with a generated default cover for books that have none.
26. Markdown export (zip of files with YAML front matter), now bundling referenced assets into an `assets/` folder and rewriting the links. EPUB export via a Node EPUB library. PDF export (added 2026-06-04 at the author's request) via a print-optimised story route with CSS paged-media rules; "Export PDF" opens the browser's print dialog, so the image carries no Chromium. All three exports consume one shared markdown-to-HTML renderer, which the public reading pages (step 27) reuse. If browser print quality ever disappoints, the upgrade path is a server-side headless-Chromium render as a worker job.
27. Public reading pages, self-host. Add `users.handle`, `users.public_archive_enabled`, and `stories.visibility`, plus the `publications` table. An admin enables a user's public archive before they can publish. Publishing a story freezes the current prose into a read-only edition; the instance serves an author shelf at `/@handle` and a reader view per public story, prose only, covers shown. Snapshot, not live: in-progress drafts never appear, and the reader path reads only the frozen editions. Adult pages carry noindex, and an admin takedown can remove an edition. The reader pages meet WCAG 2.1 AA (see `design.md`). Per-story RSS for serials is an easy follow-on.

> **-> v2.0 ships.** History, diffs, and TODO markers are real, images and covers are in, exports get your words out of the tool cleanly, and you can publish finished work to a public reading page on your own instance. The v1 feature set is complete for self-hosters, AI excepted.

## Phase 5 - Account lifecycle and hosted launch

Make the app safe to point strangers at. Up to this point Codex assumes the operator and the only user are the same person; from here on the hosted service can take sign-ups from invited friends.

28. Sign-up page. Email, password, display name. Creates a row with `approved_at = null` and sends an email-verification link. Pending users see "your account is awaiting approval" on sign-in attempts.
29. Email verification flow. Confirm-email link sets `email_verified_at`. Both this and `approved_at` must be non-null before sign-in succeeds. Transactional email via Postmark, SES, or plain SMTP; pluggable behind a small abstraction, with sending handled in the worker.
30. Password reset flow. Standard "forgot password" with token + expiry sent by email.
31. Admin approval UI. Page listing pending users (name, email, sign-up time, "approve" / "reject" buttons). Replaces the SQL-only workflow from Phase 1. Also the place an admin enables a user's public archive, after a look over what they intend to share. Operator gets an email notification on new sign-ups so the page does not have to be checked manually.
32. Account self-service. Settings page: change display name, change password, change email (re-verifies), review and revoke active sessions, claim a public handle, set preferences. Separate "danger zone" page for export-everything (a single archive of the user's universes, stories, scenes, entities, notes, and uploaded images) and delete-account: a hard delete with confirmation, cascading across owned rows and files, and on the hosted service purging the user's public editions. This is the GDPR erasure path.
32b. TOTP two-factor (promoted from the Phase 6 account-security candidate on 2026-06-04; passkeys stay deferred there). Add the `user_totp` table as an additive migration (secret encrypted at rest, `confirmed_at` null until the first code verifies). Enrolment lives on the account settings page from step 32: show the QR code and secret, require one valid code to confirm, then mark the factor active. A challenge step folds into sign-in (step 5) after the password check, only when the account has a confirmed factor, and the session is not authenticated until it passes. The factor is removable from settings, and lockout recovery in v2.5 is an admin reset (the operator clears a user's `user_totp` row); one-time recovery codes are a noted follow-on if self-service recovery is wanted.
33. Operational essentials for hosting. Basic rate-limiting on sign-up and password-reset endpoints. Structured logs to a place you will actually look at. Health-check endpoint for uptime monitoring. A cross-user isolation audit (2026-06-04): since the hosted service is one shared instance rather than a per-user one, walk every route and data-access path that touches a user's private content and confirm it is scoped to the signed-in `owner_id`, so no signed-in user can read or change another's unpublished work. (Off-host backups moved up to step 24 and shipped in v1.8.)
34. ~~Provisioning control plane~~ - dropped (2026-06-04). The hosted service is one shared instance, not a fleet, so there is nothing to provision, route, or upgrade across tenants. Deploying the hosted service is just running the Docker image, the same as self-host. The cross-user isolation that the fleet model would have given structurally is instead enforced in the application by `owner_id` scoping, and is audited as part of step 33.
35. ~~Central reader site and handle registry~~ - dropped (2026-06-04). With one instance there is no cross-instance namespace to centralise; the instance serves its own `/@handle` reader pages directly (built in step 27). A central registry would only matter for many separate instances sharing one public namespace, which this model does not have. Deferred to Phase 6 only-if-ever.

> **-> v2.5 ships.** Friends can sign up at the hosted URL, the operator approves them, they write, and they can share finished work at a public `/@handle`. Quotas remain unimplemented; the operator is expected to keep the user count small enough that they do not matter yet. The schema-level extension points for quotas are noted in `design.md` and can be added without migration when the time comes.

## Phase 6 and beyond

Everything past v2.5 is driven by real use, so these are still candidate pools rather than a contract: the order within a phase is soft, and items move between phases as priorities become clear from actually writing in the tool. The phases group the work by theme so each one ships as a coherent chunk; versions are still cut freely within a phase. (Reordered on 2026-06-04 after v2.5 shipped, to pull the writing and planning work forward and push AI and monetization back.)

A near-term fix sits outside the phases: **worker job enqueue is best-effort** (jobs.ts) and silently drops on failure, leaving the mention index stale until the next save. Make the enqueue durable, or add a periodic reconciliation, as soon as is convenient rather than gating it behind a phase.

### Phase 6 - Backend and access

The admin, durability, and access work: anything that hardens the shared instance or widens who can reach it.

- **Stored export artifacts.** Exports (markdown zip, EPUB, eventually PDF) generated server-side and kept in the asset bucket, the way GitHub releases carry assets: each publish or explicit export run produces durable, downloadable artifacts tied to an edition, instead of generating on the fly per request. Requested by the author on 2026-06-04; pairs naturally with the publications table, since an edition already freezes the content the artifact would capture.
- **Continuous backup (WAL archiving / PITR).** The hourly dumps from step 24 bound data loss to an hour; WAL streaming (wal-g or similar) would bound it to seconds, at the cost of a real operational machine. Worth it only if an hour of lost prose ever actually bites someone.
- **Account security: passkeys.** The `webauthn_credentials` table is modelled from the start; the registration and challenge flows, and the account-settings UI to manage them, are built when passwordless or hardware-backed sign-in is wanted. (TOTP moved forward to Phase 5 step 32b on 2026-06-04.)
- **Invite codes as an alternative gate.** An `invite_codes` table; sign-up accepts a code that short-circuits the approval queue. Useful when the operator wants to widen access without manually approving each one.
- **Guest review (comments, then suggested edits).** The heavyweight of this phase. An author invites a guest to review one story by magic link; the guest may be an existing user or not, and is never forced to create an account (`review_invitations`, `reviewers`). Threaded, resolvable comments anchored to a scene range come first (`review_threads`, `review_comments`). Word-style suggested edits come second and are the harder half (`review_suggestions`): a guest proposes changes the author accepts or rejects one at a time, never writing to the prose directly, with offsets re-anchored against the current text because review is async. Reuses the diff component from the History work.

### Phase 7 - Writing and planning

Make the core writing and planning experience better, not just bigger. The thing authors touch every day.

- **Entity quick details and full-fidelity entity history.** Two paired changes the author asked for on 2026-06-04 after real use of the Plan view; do them together. (1) Quick details: freeform key/value attributes (Status, Allegiance, Age, and so on) on characters, places, and lore, stored in an additive `jsonb` column, shown as the design's Details grid and surfaced in the hover popover. (2) Full-snapshot entity revisions: today a `revisions` row stores only the body markdown, so changing aliases, summary, category, or relationships records no History entry (the alias save dedupes on the unchanged body; relationships save through their own endpoint), and Restore only returns the body. Widen an entity revision to snapshot the structured fields too - the new jsonb details, aliases/keywords, summary, category, and the relationship set - so every change registers in History and Restore returns the whole entity. Relationships are a separate many-to-many table, so the snapshot serialises them rather than versioning those rows in place. The jsonb details column is part of what the snapshot must capture, which is why the two travel together.
- **Rich / WYSIWYG editing mode, with preference layering.** A softer, Word-like editing surface as an alternative to seeing raw markdown, behind a per-user preference with a per-story override. Depends on preference layering first: user-level preferences merged with per-story overrides at render time (the same pattern as `llm_config`; the story-level column is an additive migration). Deferred here from Phase 5 on 2026-06-04.
- **In-editor markdown affordances and toolbar.** Render markdown styling inside the CodeMirror editor (the shared renderer already backs export, print, and the reading pages) and add the prototype's formatting toolbar. The foundation the rich-editing choice above sits on top of.
- **Mention disambiguation.** Attribution is first-match today when two entities share an identical name or alias; design and build a dedupe/disambiguation step (mention-detect.ts). Surfaced in the pre-v1.0 review.
- **Spell-check.** Browser-native first: a `spellcheck` attribute on the editor with `lang` taken from a user language preference (the preferences UI shipped in step 32). A dedicated checker library only if the native one proves insufficient.
- **Library and story-settings styling.** Bring the library (dashboard) and the story settings pages onto the sidebar design system the admin and account pages adopted in Phase 5, so the whole app reads as one surface.
- **Command palette (Ctrl+K).** Absorbs search and cross-view navigation.

### Phase 8 - Overviews and visualization

New surfaces that render existing data back to the author: where the world and the work-in-progress become legible at a glance.

- **Entity heatmap at universe scope.** Derived from existing mention and revision data. Shows which entities are central vs forgotten, which parts of the world are under-developed. Nearly free, uses data the tool already has.
- **Progress dashboard.** Word counts across stories, scenes by status, streaks, writing velocity. Mostly stats rendered as charts.
- **Scene cards on a board.** Visual planning surface; an alternate rendering of the existing outline and scene data.
- **Relationship web view.** Graph rendering of the `entity_relationships` data built in phase 3 step 18. Force-directed layout, filters by entity or relation type.
- **Timeline view.** Requires "what is a date in your world" design work first; potentially dependent on a first-class calendar model.
- **Plotlines and arcs as first-class entities.** Promoted from scene tags / metadata jsonb if real use shows it is needed; pairs with the board and timeline surfaces above.

### Phase 9 - AI and interop

The large, deliberately-deferred work: machine assistance and exchange with the AI-roleplay tooling ecosystem.

- **LLM integration.** Its own phased project when the time comes, and the largest item on this list by a wide margin. Anticipated shape (sketched in `design.md`): an LLM gateway service with a streaming completion call, per-user and per-story LLM settings UI writing to the reserved jsonb columns, a rubber-duck chat in the right sidebar's Session tab, a co-author side panel with context assembly drawing on the existing mentions index, inline continuation as a CodeMirror ghost-text extension distinct from entity autocomplete, and finally an editor role with margin annotations. Do not start this until v1 has been used enough in anger that the gaps are obvious from the inside. Prototyping the gateway early is the most tempting wrong move on this entire roadmap.
- **Session tab refinements.** Deferred with the AI work. Chat persistence, conversation browsing, collapse control for quick settings when chat grows long, none of it matters until the chat exists.
- **SillyTavern and lorebook import.** Character card import (PNG with embedded JSON), lorebook JSON import, round-trip export. Originally Phase 4 step 24; dropped from the v2.0 scope on 2026-06-04. The `imported_from` column and `activation_mode` enum already model for it, so it can return without a migration.

### Phase 10 - Monetization

- **Quota enforcement and billing.** The plan and entitlement model exists from the start (see `schema.md`); what is deferred is enforcing it (rejecting saves or creates that exceed an entitlement, and maintaining `storage_used_bytes`) and, much further out, charging money for a hosted tier. Billing would add a subscription layer that sets a user's `plan_id`; no payment processing is planned for the foreseeable future.

### Future - deferred hard

Reach and platform bets, each expensive or unsettled enough to stay out of the numbered phases until something forces the question.

- **Downloadable desktop build.** A one-click installable app for users who want self-host without Docker - Electron hosting the SvelteKit Node server in-process, with the database embedded via PGlite and Drizzle's driver swapped from `node-postgres`. The stateless Node server and SQL-first data layer mean the architecture already preserves this option; verify embedded availability of the `pg_trgm` extension before committing, with app-side fuzzy matching as the fallback. An option, not a plan.
- **Offline editing with sync (local-first).** Edit on your device while offline; changes reconcile with the server as soon as you are back online, in the spirit of Obsidian's Sync. The most ambitious of the deployment models, and dependent on the downloadable/local build above - a server-rendered web app has no local copy to edit against offline (a service-worker PWA is the alternative route to a local store). Scope it deliberately to **single-user, multi-device** to stay clear of the multi-author CRDT work this project has ruled out: sync the authored content (markdown plus a few fields) and recompute derived data (mentions, word counts) on each side, preserving genuine conflicts as conflict-copy `revisions` rather than merging them silently. The emerging Postgres-native sync tooling (ElectricSQL, PowerSync, PGlite) targets exactly this, but it is the least settled technology on this list - reason enough to keep it firmly deferred.
- **Mobile review UI.** Read-only first; editing much later, if ever. Kept with the desktop and offline work as another shape of the same client-reach question.
- **Map as first-class surface.** Deferred hard, expensive to build and maintain, narrower audience than the other views.

## Principles for sequencing

- **Use it as you build.** Draft real words in the tool from phase 2 onward. The frustrations you hit drive the best backlog.
- **Test as you build.** Write tests alongside each step, not in a cleanup pass at the end, and treat a step as unfinished until they pass. Close to test-driven without being strict about it. See the testing section in `CLAUDE.md` for how the unit, integration, and end-to-end layers divide the work.
- **One entity type fully before adding the next.** Build characters end-to-end, then places, then lore. Parallel development means parallel half-finished features.
- **Do not build the LLM layer in v1, at all.** Resist the temptation to prototype the gateway early. The writing app has to earn its keep on its own, and the LLM layer will benefit enormously from having a real corpus of your prose to calibrate prompts and context assembly against.
- **Wrap every swappable editor behaviour in a CodeMirror Compartment from phase 2.** Cheap up front, expensive to retrofit. Mentions, autocomplete, possibly future linting and (eventually) continuation-mode ghost text all want independent reconfiguration.
- **Keep a TODO.md in the repo.** The worst failure mode for a solo project is chasing the interesting tangent before finishing the main path.
- **Revisions are cheap to skip early.** If you build the revisions table in phase 2, you are making design choices on assumptions. Phase 4 is better.

## What is not on the roadmap

- Real-time collaboration (CRDTs etc). The single-author assumption holds; guest review (Phase 6) is async and never lets two people edit at once. Offline multi-device sync, if it is ever built, stays within that single-author boundary (see Phase 6).
- Non-OpenAI-compatible LLM providers. When the LLM work eventually happens, the gateway will abstract this away; any non-compatible backend will be a new adapter. None of this matters in v1.
- A full mobile editing experience beyond read-only. Deferred.
- Open registration. The sign-up form exists, but a new account stays inactive until the operator approves it; there is no path to an active account without approval.
