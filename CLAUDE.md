# Codex

A writing workspace for long-form creative work: novels, serials, worldbuilding, and TTRPG campaigns. Self-hostable and browser-based, with a hosted service offered alongside. The design, schema, and roadmap live in `scratch/system-design/`. UI design is handed off from Claude Design as a React prototype in `scratch/app-design/` (a no-build app: `codex.html` mounts the `src/*.jsx` components with Babel in the browser, over fake data on `window.CODEX_DATA`), with reference screenshots in `scratch/app-design/screenshots/`. Treat it as a visual and behaviour spec, not code to transplant. Port the CSS (`tokens.css`, `theme.css`, `pages.css`) closely, since it is the design system; reimplement the screens in Svelte rather than copying the JSX, carrying the component split across (app shell, left/center/right columns, editor) and translating React state and effects to Svelte's reactive model. The prototype editor is a `contentEditable` mock and is not authoritative: the real editor is CodeMirror 6, so rebuild its behaviour (mentions, underlines, tooltips) there instead of porting the prototype's DOM manipulation. The prototype fakes data and persistence in the browser, so do not infer the client/server split from it; derive that from the design. Ignore the `EDITMODE` markers, which are Claude Design's own scaffolding. The `scratch/` workspace is planning material and is not part of the application repository.

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

## Working approach

- Challenge decisions that no longer fit. If the design or use case has shifted enough to undermine an earlier choice, say so instead of building around it.
- When in doubt, ask. A short question beats a wrong assumption, especially on anything hard to reverse.
- Keep comments and commit messages concise. Say what is not obvious and stop; do not narrate the obvious or pad the message.
