# TODO

Working checklist against `scratch/system-design/roadmap.md`. One roadmap step
per line; details live in the roadmap. Cross off as things merge to develop.

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
  - [ ] 32-danger. Danger zone, two parts (build export first - it is the "export first" safety net and is read-only):
    - [x] Export-everything (v2.4.3): /account/export downloads one zip of every universe (description), character/place/lore entry (front matter + summary + body), and full story (chapters/scenes), with referenced images and covers bundled and links rewritten. Reuses the step 26 exporter pieces. Story-scoped note overlays not yet included (noted).
    - [x] Delete-account (v2.4.4, GDPR with a 7-day regret period): self-service delete on /account re-confirms the password, then deactivates the account (suspended + sessions dropped) and takes down all public editions at once, sets deletion_scheduled_at +7d, and emails a cancellation link (/cancel-deletion) that reactivates if clicked in time. A worker job (hourly) purges accounts past the window: full hard cascade (shared deleteStoryWithin per story, then universe entities/categories/relationships, assets + S3 objects, sessions/tokens/user). Admin delete on /admin runs the same cascade immediately (never an admin or self). Migration 0020 adds deletion_scheduled_at; deletion_cancel token kind added. Editions stay down on cancel (republish to restore) - noted.
  - Note: handle claim and preferences already live on the dashboard; fold them into /account when the page is consolidated.
- [ ] Design adaptation (author's design in scratch/app-design/new_admin/, handed over 2026-06-04). Redesign /admin and /account onto the new sidebar-shell design system; full scope agreed (avatar, pen name + social links, theme + accent colour, stubbed deferred sections). Build in slices, each its own release toward v2.5:
  - [x] D1. Design-system port: brought admin.css and pages.css into src/lib/styles (loaded globally after theme.css). Reconciled with the editor system: added the missing --radius-md token; scoped theme.css's unused entity-detail .field under .fields so the bare .field is free for forms; scoped the page-shell .topbar/.brand under .page-shell so the editor top bar is untouched; reused the editor's existing .seg/.toggle rather than duplicating them (kept the new .toggle-row, .toggle-xl). No visible surface yet (D2-D5 consume these); lint, check, unit tests, and build pass.
  - [x] D2. /admin rebuilt on the new sidebar shell. Overview (stat cards from instanceStats + a real "needs attention" list + health footer), Users & access (pending approvals + accounts table with role tags and row actions: approve/decline/publishing/suspend/delete, guarding admins and self), Published (editions + take-down, kept from the old page as its own nav item), Backups (configured state, run-now, run history), Email relay (SMTP form). AI / Usage / Audit are visible "soon" stubs. instanceStats() added to admin.ts with integration tests; all existing actions and the non-admin 404 gate unchanged.
  - [x] D3. /account rebuilt on the sectioned shell (Profile / Security / Display). Profile: display name + public-page block (claim handle write-once, bio, profile-public toggle), gated on publishing being enabled. Security: change email, change password, two-factor placeholder (32b), sessions, export, delete. Display: editor preferences (autocomplete, scene marks). Folded the handle claim and preferences in from the dashboard (now just the library + a pointer to /account); added saveProfile() and claimHandle() to account.ts with integration tests; surfaced handle/bio/profile-public. e2e account + core-flow specs updated and green. Theme/accent -> D5; pen name/social/avatar -> D4.
  - [ ] D4. Profile new fields: pen name (new column) + social links (jsonb) + commissions line; surface on the public /@handle shelf. Avatar upload (new column + reuse the S3 asset store; initials fallback).
  - [ ] D5. Theme + accent colour: Display section preference, persisted and applied app-wide via the CSS variables.
- [ ] 32b. TOTP two-factor: build into the redesigned /account Security section using the design's flow (QR + segmented code + recovery codes). user_totp additive migration (secret encrypted via crypto.ts), confirm a code to activate, recovery codes generated and shown once; challenge folded into sign-in after the password (short-lived pending state); admin reset for lockout. Vetted TOTP lib + qrcode. Passkeys stay in Phase 6.
- [ ] 33. Operational essentials (rate-limit sign-up and reset, structured logs, health-check endpoint) plus a cross-user isolation audit: the hosted service is one shared instance, so confirm every route and data-access path that touches private content is scoped to the signed-in owner_id.
- [x] 34 + 35. Dropped (2026-06-04): the hosted service is one shared instance (GitHub model), not a per-user fleet, so there is no control plane to provision and no central cross-instance reader/handle registry. Deploying the hosted service is just running the image; cross-user isolation is enforced by owner_id scoping and audited in step 33. See the design-doc update.
- [ ] In-app help (/docs), held to the end of Phase 5. Help articles as
      committed markdown rendered through the existing renderMarkdown (no wiki
      engine, no docs SaaS: too much ops surface and breaks self-host/offline
      for an audience this small). Routes /docs and /docs/[topic]; a reusable
      "?" HelpLink component placed on the editor, Plan, publish, and backups
      pages, opening the relevant topic. Tone follows the CLAUDE.md writing
      rules (kind, plain, tells the reader what to do, no jargon). Articles
      live in the repo so they version with the features they describe.

## Feedback backlog

From first real use (2026-06-03):

- [x] Scene marks in the continuous view should be hideable: shipped with v1.10 (continuousSceneMarks preference)
- [x] Editable continuous view: shipped with v1.10 (roadmap step 23b)
- [ ] Spell-check from a user language preference (Phase 6 candidate; browser-native first)
- [ ] Markdown affordances: the shared renderer shipped with v1.12 (exports + print); reading pages pick it up in step 27; in-editor styling and the prototype's toolbar remain as polish
- [ ] Preference layering: user-level preferences with per-story overrides merged at render time (same pattern as llm_config); story-level column is an additive migration
- [ ] Default editing format preference (deferred to Phase 6 on 2026-06-04). The editor is CodeMirror over raw markdown today; a writer should be able to choose a softer, Word-like editing surface rather than seeing markdown syntax. A rich/WYSIWYG editing mode behind a preference, settable at user level with a per-story override. Builds on the "markdown affordances" and "preference layering" items above; that is the foundation, this is the user-facing choice on top
- [x] Entity colours with meaning: shipped with v1.2 (characters/places join categories; badge takes the category colour)

From the pre-v1.0 code review (2026-06-03); the four fixable findings were fixed:

- [ ] Mention attribution is first-match when two entities share an identical name or alias; needs a dedupe/disambiguation design (mention-detect.ts)
- [ ] Hover tooltip re-runs full-document detection per hover; read from the existing decoration set instead (editor-mentions.ts)
- [ ] applySceneOrder issues one UPDATE per scene; batch into a single statement when stories grow (scene-order.ts)
- [ ] updateMarkerAnchors issues one UPDATE per anchor in a loop; batch it the same way (markers.ts)

From a pre-v2.0 self-review (2026-06-04); the cover IDOR and the duplicated media-types map were fixed:

- [x] The worker-indexed find-usages e2e assertion was timing-flaky on loaded CI runners. Widened the toPass window to 60s, then (v2.1) marked the journey test slow and switched to set-membership assertions, then gated test start on worker readiness (global-setup waits for the worker's "started" log before any test relies on the async index, and captures its output to a file). Recurred across the v2.0.1 and v2.1 release runs each time, so chased to the readiness race rather than re-running.
- [ ] For the v2.5 review: worker job enqueue is best-effort and silently drops on failure (jobs.ts), so a dropped mention rebuild leaves the index stale until the next save. Fine for a single-operator tool, but worth deciding whether a periodic reconciliation or a durable enqueue is wanted before the hosted launch. This was the suspected deeper cause behind the find-usages e2e flake.
- [x] CI never ran the Docker image, so a broken worker import closure shipped silently (caught by hand at v1.6: src/lib was missing from the image since step 14). Fixed in v1.6.1 with a docker-smoke CI job that builds the image and boots compose with a worker check

Later phases tracked in the roadmap until they get close.
