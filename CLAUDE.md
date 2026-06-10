# Codex

A writing workspace for long-form creative work: novels, serials, worldbuilding, and TTRPG campaigns. Self-hostable and browser-based, with a hosted service offered alongside. The design, schema, and roadmap live in `scratch/system-design/`. UI design is handed off from Claude Design as a React prototype in `scratch/app-design/` (a no-build app: `codex.html` mounts the `src/*.jsx` components with Babel in the browser, over fake data on `window.CODEX_DATA`), with reference screenshots in `scratch/app-design/screenshots/`. Treat it as a visual and behaviour spec, not code to transplant. Port the CSS (`tokens.css`, `theme.css`, `pages.css`) closely, since it is the design system; reimplement the screens in Svelte rather than copying the JSX, carrying the component split across (app shell, left/center/right columns, editor) and translating React state and effects to Svelte's reactive model. The prototype editor is a `contentEditable` mock and is not authoritative: the real editor is CodeMirror 6, so rebuild its behaviour (mentions, underlines, tooltips) there instead of porting the prototype's DOM manipulation. The prototype fakes data and persistence in the browser, so do not infer the client/server split from it; derive that from the design. Ignore the `EDITMODE` markers, which are Claude Design's own scaffolding. The `scratch/` workspace is planning material and is not part of the application repository.

The prototype (`scratch/app-design/`) is gitignored, so a fresh clone will not have it. Without it, work from the committed design docs in `scratch/system-design/`, the design system already ported to `src/lib/styles/`, and the patterns in the existing screens; if a step genuinely needs the visual spec and it is absent, say so rather than inventing a layout.

Progress is tracked in `TODO.md` (current step, feedback backlog, review follow-ups); keep it updated as steps complete.

Stack: SvelteKit and TypeScript, Drizzle on Postgres, a pg-boss worker for background jobs, CodeMirror 6 for the editor, Caddy for TLS.

## Writing rules

- Use plain ASCII punctuation. No em dashes, en dashes, or curly quotes. Hyphens, commas, parentheses, and straight quotes only. This applies to code, docs, and UI text.
- Help and instruction text in the UI is for someone who has never seen the app before. Tell them what to do, not why the app was built a certain way. Leave the reasoning out.
- Keep jargon and slang out of user-facing text. In code, skip comments that only restate what an obvious function already does, and comment the things that are not obvious.

## Engineering principles

- Apply the usual principles: DRY, KISS, SSOT, YAGNI. Prefer the simplest thing that works, and do not build ahead of the roadmap; the design defers a lot on purpose, so resist pulling deferred features forward.
- The Drizzle schema is the single source of truth for data. Change the database only through a generated migration, and prefer additive, reversible migrations that do not rewrite existing rows.
- Keep server-only code server-only. Database access, secrets, and session checks belong in server modules (`$lib/server`, `+server.ts`, `hooks.server.ts`) and must never reach the browser.
- Authored content stays exportable. Anything holding a user's words is stored as markdown that round-trips through export; do not introduce a format that traps content.
- Prefer what is already here. Reach for the standard library or an existing dependency before adding a new one, favour stable low-churn packages, and match the patterns and naming already in the file.
- Keep the in-app help current. When you add or change user-facing functionality, check whether a help article in `src/lib/docs/` covers it and update or add one so the docs stay in step with the features. Admin-only panels do not need help articles.

## Testing

- Write tests alongside the code, not in a pass at the end. This is not strict test-driven development, but lean towards it: for anything with real logic or a contract (a server endpoint, a data-access function, a parser), write the test with or just before the implementation. A bug fix starts with a failing test that reproduces it.
- Three layers, each with a clear job:
  - **Unit (Vitest).** Pure logic with no I/O: mention detection, position maths, markdown round-trip, alias matching, token and slug helpers. Fast, no database.
  - **Integration (Vitest against a real Postgres).** Server endpoints, Drizzle queries, and migrations, run against a throwaway test database rather than a mock. The queries are thin and SQL-first by design, so a mocked database would test nothing real. Reset state between tests (a per-test transaction rolled back, or a truncate).
  - **End-to-end (Playwright).** A small set covering the journeys that must never break: sign in, create a universe and a story, draft a scene and see it persist after reload. Playwright is already provisioned in the dev harness.
- Test behaviour and contracts, not implementation details, so a refactor that preserves behaviour does not break the suite. Do not chase a coverage number; cover the paths that matter and the ones that have broken before.
- A roadmap step is not done until its tests pass. Keep the suite fast and deterministic; a flaky or slow test gets fixed or removed, not tolerated.
- Run the tests locally before pushing, wherever the environment allows it. The local suite is much faster than a CI runner, so `npm run lint` and `npm test` (or at least the unit tests and any relevant end-to-end ones) catch most failures without the wait. CI is the backstop, not the first place a failure should surface.

- If the environment cannot run the database-backed or Playwright tests (some sandboxes cannot), still write them, run what does run (lint, check, unit tests without I/O), say plainly in the PR what was not verified locally, and let CI gate the merge. Do not claim a step done on unverified tests.

## Branches and releases

- `develop` is the integration branch; `main` carries releases only. Feature work happens on `feat/<name>` (or `fix/`, `chore/`, `ci/`) branched off `develop`, merged back by squash after every CI check passes. GitHub auto-deletes merged head branches.
- Roadmap steps release as their own version (the roadmap says which). Release flow, in order: bump the version on `develop` (`npm version X.Y.Z --no-git-tag-version`, commit), cut a throwaway `release/vX.Y.Z` branch, reconcile squash-history divergence with `git merge -X ours origin/main`, PR to `main`, squash-merge after checks, verify `origin/main` actually moved (`git log origin/main --oneline` after a fetch), tag `vX.Y.Z` on `origin/main`, publish a GitHub release, then back-merge `main` into `develop` with `-X ours` and delete the release branch. From an environment that cannot push tags (remote sessions), the tag and release step is the Release workflow instead: dispatch it on `develop` with the version, and it tags `main`, publishes the release, and kicks the image build.
- Never pipe `gh` merge or check commands through `tail`/`head`: the pipe masks exit codes, and that has shipped a mistagged release before. Use `gh pr checks <ref> --watch` bare and read the result.

## Working approach

- Challenge decisions that no longer fit. If the design or use case has shifted enough to undermine an earlier choice, say so instead of building around it.
- When in doubt, ask. A short question beats a wrong assumption, especially on anything hard to reverse.
- Keep comments and commit messages concise. Say what is not obvious and stop; do not narrate the obvious or pad the message.
