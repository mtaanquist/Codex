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

> v0.1 ships at the end of Phase 1.

## Phase 2 - Core content

- [x] 7. universes, stories tables; CRUD pages
- [x] 8. Shell layout port from prototype (top bar, three columns, CSS tokens)
- [x] 9. Focus mode
- [x] 10. chapters, scenes; scene tree in left sidebar
- [x] 11. CodeMirror 6 editor, debounced autosave, Compartment wrapping
- [x] 12. Drag-to-reorder scenes
- [x] 12b. Continuous story view, read-only (pulled forward from Phase 6)

> v0.5 ships at the end of Phase 2.

## Feedback backlog

From first real use (2026-06-03):

- [ ] Scene marks in the continuous view should be hideable (display preference; rides with roadmap step 23b or the preferences UI)
- [ ] Editable continuous view: promoted to roadmap step 23b, ships as a v1.x release
- [ ] Spell-check from a user language preference (Phase 6 candidate; browser-native first)
- [ ] Markdown affordances: renderer lands with Phase 4 exports and reading pages (continuous view picks it up); in-editor styling and the prototype's toolbar as polish after; visibility of marks likely a display preference
- [ ] Preference layering: user-level preferences with per-story overrides merged at render time (same pattern as llm_config); story-level column is an additive migration

Later phases tracked in the roadmap until they get close.
