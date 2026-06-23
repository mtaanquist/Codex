# Universe-aware Assistant: Plan-page tabs, cross-story continuity, Write context, and the command palette

## Context

The writing Assistant (right-pane chat) is helpful while drafting but is missing
from the planning surfaces, and it is blind beyond a single story. Two needs drove
this:

1. While planning, the writer wants the Assistant on hand to ask questions and get
   opinions, on both the **story** Plan page and the **universe** Plan page.
2. For continuity, the Assistant has to see across stories. Starting Story 2 and
   wanting to reference an event, character detail, or place from Story 1 is the
   motivating case: today the Assistant only grounds itself in the one open story,
   so it cannot check anything against the rest of the universe.

The user confirmed: deliver all of this as one change, and the per-story Assistant
(Write and story Plan) should also gain cross-story reach, not just the new
universe Plan surface.

## Design: one Assistant, universe reach, optional focus

The unifying idea, which also answers "reuse, don't build several versions":

- **Reach is the whole universe; focus is optional.** Every layer carries a scope:

  ```ts
  type AssistantScope =
    | { universeId: string; storyId: string; sceneId?: string } // per-story focus
    | { universeId: string };                                   // universe surface
  ```

  The universe is always present (it is the retrieval reach); the story/scene focus
  is the optional part. The story Plan tab is the focus scope with no scene; Write
  is the focus scope with a scene; the universe Plan tab is the universe-only scope.

- **One shared panel, one shared backend path.** `AssistantPanel.svelte` is already
  the single chat component (used by Write and Review today). We generalize it to
  take the scope discriminator so the *same* component serves all four surfaces
  (Write, Review, story Plan, universe Plan). We do **not** add a parallel endpoint
  or a duplicate context assembler: we thread `universeId` (plus optional focus)
  through the existing endpoint -> gateway -> tools -> context-assembly chain.

- **Cross-story reach comes from the tools, not from dumping prose.** The retrieval
  tools become universe-scoped, which is what gives both the per-story and universe
  surfaces continuity reach. Context carries story *summaries/outlines* as the
  backbone; the model pulls specific scenes/prose on demand via `get_scene`. Bodies
  never enter the assembled context (token budget stays bounded).

## Implementation (ordered)

### 1. Schema + chat-history scope API (foundational)
- `src/lib/server/db/schema.ts` — on `assistantChatMessages`: drop `.notNull()` on
  `storyId`, add nullable `universeId` (FK to `universes`), add a CHECK that exactly
  one of the two is set (`(story_id is null) <> (universe_id is null)`), and a new
  index `(universeId, userId, createdAt)`. Generate the migration with
  `drizzle-kit generate` (do not hand-write). Additive and safe: all existing rows
  have `story_id` set, so the CHECK holds with no row rewrites.
- `src/lib/server/llm/chat-history.ts` — introduce `ChatScope = { storyId } |
  { universeId }` and a `scopeWhere(scope)` helper; rewrite `listChat`,
  `appendChat`, `clearChat`, `setProposalConfirmed` to key on the scope. Add
  `deleteChatForUniverses` and wire it into the universe delete cascade. Update call
  sites: `routes/api/assistant/chat/+server.ts`, `llm/assistant-route.ts`,
  `routes/api/stories/[id]/assistant-proposal/+server.ts` (always `{ storyId }`),
  `routes/stories/[id]/+page.server.ts`, `routes/stories/[id]/review/+page.server.ts`.

### 2. Context assembly (sources + assemble)
- `src/lib/server/llm/context/sources.ts` — add `loadUniverseScope`,
  `universeSkeleton` (per owned story in the universe, reuse `storySkeleton`,
  summaries only, capped), and `universeEntities` (reuse `planEntityLists` for the id
  set, then the existing entity-building body). Refactor `inScopeEntities` to take an
  explicit id list so story and universe paths share it; make `storyId` optional in
  `activeLore` and `scopeNotes` (universe path skips the per-story overlay note).
- `src/lib/server/llm/context/assemble.ts` — generalize `assembleContext` to branch
  on the scope:
  - **Focus path** (storyId present): the existing tiers plus a new low-priority
    `universe-backbone` tier — a compact index of the *other* stories (title, brief,
    scene count, one-line outline) via `universeSkeleton` minus the focus story, so
    the model knows what else exists and can pull detail with tools. New renderer
    `renderUniverseBackbone(..., { excludeStoryId })`, placed last (drops first under
    budget pressure).
  - **Universe path** (no storyId): `universe-frame`, `universe-outline` (every
    story's outline grouped by story), `entities` (universe-wide), `lore`, universe
    `notes`. No scene-local tier. New `renderUniverseFrame` / `renderUniverseOutline`,
    plus a `PREAMBLE_UNIVERSE`. Extend `TOOL_HINT` to mention cross-story reach.
  `assembleRecapContext` stays story-only (recap is "the story so far").

### 3. Tools become universe-scoped
- `src/lib/server/llm/tools/dispatch.ts` — `ToolContext`: replace `storyId: string`
  with `universeId: string; storyId?: string`. Add `ownsUniverse(db, userId,
  universeId)`. `loadScene` scopes by `stories.universeId` + `stories.ownerId` (drop
  the `storyId` constraint) and selects the scene's owning `storyId`. Per tool:
  `list_scenes` -> `universeSkeleton` grouped by story; `get_scene` -> any owned
  scene in the universe; `find_appearances` -> `entityAppearances(..., { universeId })`
  emitting `storyId`/`storyTitle`; `search_text` -> universe-filtered (see step 6).
  `get_entity` already owner-scoped (no change). The write tools (`suggest_edit`,
  `leave_comment`, `propose_scene_split`) stay focus-bound and must use the loaded
  scene's `storyId`, not `ctx.storyId`.
- `src/lib/server/llm/tools/registry.ts` — update the descriptions of `list_scenes`,
  `find_appearances`, `search_text` to say "across the stories in this universe".

### 4. Gateway threading
- `src/lib/server/llm/gateway.ts` — add `universeId?: string` to `GatewayRequest`;
  enable tools when `universeId` present and `ownsUniverse(...)`; build
  `toolContext = { db, userId, universeId, storyId, scope, allowedTools }`.
  `resolveLlmConfig`/usage recording already tolerate an undefined `storyId`.

### 5. Gate + route helpers + endpoint
- `src/lib/server/llm/config.ts` — the existing `assistantLayout(db, userId)` with no
  storyId already yields the account-level gate (`muted: false`); use it for the
  universe surface. No per-universe mute in scope (follow-up).
- `src/lib/server/llm/assistant-route.ts` — add `requireAssistantUniverse(userId,
  universeId)` (ownership + account gate); generalize `assistantSseResponse` and its
  `appendChat` to take the scope.
- `src/routes/api/assistant/chat/+server.ts` — POST reads `storyId` or `universeId`
  (+ `sceneId`); builds the scope (`requireAssistantStory` gives `universeId` for the
  focus path, else `requireAssistantUniverse`); appends chat, assembles context, and
  calls `assistantSseResponse({ scope, enableTools: true, ... })`. DELETE clears by
  scope. Recap endpoint stays story-only.

### 6. search_text scoping
- `src/lib/server/search.ts` — add an optional `universeId` filter to `searchAll`
  (thread `eq(universes.id, universeId)` into the subqueries). The command palette
  keeps calling it unfiltered; the tool passes the universe.

### 7. Shared panel + both Plan pages (the reuse payoff)
- `src/lib/components/AssistantPanel.svelte` — replace required
  `storyId`/`storyTitle` with the scope discriminator (`{ storyId, storyTitle } |
  { universeId, universeName }`). The POST/DELETE/recap bodies send the scope;
  `sceneId` only in story mode. Universe mode: no recap / summaries / mute UI / editor
  props (`onInsert`/`onConfirmSplit`/`onRevertSplit`), a universe-flavoured opening
  line, and guard `catchUp` to a no-op. All existing story behaviour stays identical.
- `src/routes/stories/[id]/plan/+page.{svelte,server.ts}` — server: add
  `assistantLayout(db, userId, story.id)` and `listChat(db, userId, { storyId })`;
  return `assistant` + `assistantChat`. Page: add `'assistant'` to `rightTab`, a
  pill gated on `data.assistant.tabEnabled`, and `<AssistantPanel scope={{ storyId,
  storyTitle }} ... />` (no editor props — the Plan page has no editor).
- `src/routes/universes/[id]/plan/+page.{svelte,server.ts}` — server: add
  `assistantLayout(db, userId)` (account gate) and `listChat(db, userId,
  { universeId })`. Page: mirror the pill + `<AssistantPanel scope={{ universeId,
  universeName }} ... />`, with universe-flavoured starter suggestions
  (e.g. "Check continuity across the stories").

Reuse note on the tab pill: the *panel* is the shared component. The per-page pill
button + `{#if rightTab === 'assistant'}` branch is ~5 lines and each page's tab set
differs (Reference/History/Session/Assistant), so keep those inline rather than
over-abstracting a wrapper for so little shared markup.

## Part B: Co-author "Write" continuity and voice

Separate symptom, same machinery. The toolbar **Write** action (`CoauthorPanel` ->
`/api/assistant/coauthor/+server.ts`) calls `assembleContext`, but its scene-local
tier (`renderSceneLocal` in `assemble.ts`) only includes the *current* scene's body
in full; neighbouring scenes are summaries only (`sceneNeighbourhood` in
`sources.ts` returns `summaryMd` for neighbours, not `bodyMd`). So on a new/empty
scene there is no prose to continue from ("continue from the previous scene" sees
only a one-line summary) and no real voice sample to match (style drifts). The
client only captures up to 400 chars before the cursor, which is empty at the top of
a fresh scene.

Fix: give the Write action the immediately preceding scene's actual prose as a
continuity and voice anchor, capped to respect the budget.

- `src/lib/server/llm/context/sources.ts` — extend `sceneNeighbourhood` so the
  nearest "before" neighbour also carries its `bodyMd` (or add a small
  `precedingSceneBody(db, storyId, sceneId)` returning `{ title, bodyMd }` of the
  scene immediately before by `globalPosition`). Reuse the existing
  `globalPosition` ordering already in `sceneNeighbourhood`.
- `src/lib/server/llm/context/assemble.ts` — add an opt-in option to
  `assembleContext` (e.g. `precedingProse?: boolean`). When set and a focus scene
  exists, `renderSceneLocal` renders a "Previous scene (the prose continues into
  this one)" block with a tail excerpt of the preceding scene's body, capped (reuse
  the `RECAP_BODY_EXCERPT_CHARS` ~1500-char pattern). This is most valuable when the
  current scene is empty or short, exactly the reported case.
- `src/routes/api/assistant/coauthor/+server.ts` — pass `precedingProse: true` into
  `assembleContext`. The cap keeps it within the existing budget; bump
  `MAX_COAUTHOR_TOKENS` only if needed.

Scope it to the Write action via the opt-in flag so ordinary chat turns are not
inflated; the chat surface can adopt the same flag later if wanted. The story's
`styleNotes` already ride in the frame tier; the preceding-prose excerpt is the
missing piece that anchors voice on a fresh scene.

## Part C: `/write <brief>` chat command

Not present today. The chat slash commands are `review`, `catchup`, `summaries`,
`clear`, `help` (`src/lib/assistant-slash.ts`), and `runSlashCommand` in
`AssistantPanel.svelte` only reads the command *name* (`slashName`) and discards the
rest of the line. Add a `/write` command where everything after `/write` is the
brief, routed to the same co-author drafting the toolbar Write button uses, so the
writer can draft a passage without leaving the chat.

- `src/lib/assistant-slash.ts` — add `{ name: 'write', detail: 'Draft a passage from
  a brief (everything after the command)' }`, and add a generic `slashArgs(raw):
  string` helper returning the text after the first token (reuse the same split as
  `slashName`). Keep it generic so other commands can take arguments later, but only
  `/write` uses it now.
- `src/lib/components/AssistantPanel.svelte` — in `runSlashCommand`, add
  `case 'write':` that reads `const brief = slashArgs(raw)`. If empty, append a short
  usage hint as an assistant message. Otherwise call a new `coauthorDraft(brief)`:
  it appends the brief as a user turn (so the transcript shows the ask), POSTs to
  `/api/assistant/coauthor` with `{ storyId, sceneId, instruction: brief }` (the same
  buffered endpoint and payload the `CoauthorPanel` uses), and appends the returned
  `{ text }` as an assistant message. The existing per-message Insert affordance
  (shown when `onInsert` is set, i.e. a single scene editor is open) lets the writer
  drop the passage into the prose; no new insert UI needed.
- Scope: `/write` needs a story focus (and is most useful with an open scene, where
  Part B's preceding-prose context kicks in). On the universe Plan surface (no story
  focus) the command replies that drafting needs an open story or scene. Gate this in
  the `write` case via the scope discriminator, consistent with how the universe mode
  already hides recap/summaries.

This reuses the co-author endpoint and prompt wholesale (no new server route); it is
a thin client command plus one slash-args helper.

## Part D: `/continuity-review` command

Worth doing, and it reuses more than it adds. The review system already has a
cross-scene **consistency pass** (`buildConsistencyMessage` in
`src/lib/server/llm/prompts/review.ts`, run by `reviewStoryConsistency` in
`src/lib/server/llm/scene-review.ts`) that explicitly checks continuity (names,
titles, facts drifting between scenes; timeline arithmetic). Today it only runs as
the tail of a *full* copyedit (`isFullReview` + multi-scene scope) and is
story-scoped. Findings persist as review threads/suggestions anchored to scenes
(`review_threads`/`review_suggestions`), surfaced on the review page.

Promote that pass to an on-demand continuity review, invokable as a slash command,
and extend it across the universe using Part A's machinery.

- Make the consistency pass runnable on its own (continuity-only), not just as a
  copyedit tail. In `scene-review.ts`, allow a "continuity" review mode that runs
  `reviewStoryConsistency` over the scope's scenes without the per-scene
  mechanics/prose/lore passes. Reuse `buildConsistencyMessage` as-is for the
  story-level case.
- Reuse the existing background job path (`/api/assistant/review-job` +
  `queueAssistantReview`) since it spans many scenes; add a `mode: 'continuity'`
  (or `kind`) to the job payload rather than a new endpoint. Findings stage through
  the same `leave_comment`/`suggest_edit` tools and land in the same tables, so the
  review page presents them with no UI change.
- **Universe scope (the headline case):** on the universe Plan surface, run a
  universe-wide continuity pass. Build on Part A: feed the universe outline +
  entities + lore as context and let the universe-scoped tools (`get_scene`,
  `find_appearances`, `search_text`) pull specifics from any story. Because the
  write-tools now resolve a scene's owning `storyId` (Part A, Layer 1), a
  contradiction found in Story 1 stages a thread on Story 1's scene, even when the
  pass was launched while planning Story 2. A new `buildUniverseConsistencyMessage`
  variant frames the task as cross-story ("flag facts, timeline, character, and place
  details that contradict each other across the stories in this universe").
- Slash command: add `{ name: 'continuity-review', detail: 'Check for continuity
  contradictions' }` to `SLASH_COMMANDS`. In `runSlashCommand`, a story-focus scope
  kicks off a story-level continuity job; the universe scope kicks off a
  universe-wide job. Confirm kickoff and notify on completion through the existing
  activity-center job flow (like the current background review).

Scope note: the story-level continuity command is a small, low-risk reuse. The
universe-wide pass is the larger piece and depends on Part A landing first; if the
combined effort needs trimming, the universe-wide variant is the natural thing to
split into its own follow-up while still shipping the story-level command.

## Part E: more commands + slash-menu polish

The slash popup already exists: `AssistantPanel.svelte` renders a `.slash-menu`
listbox (line 518) the instant `/` is typed, filtered by `matchSlash`, with
Up/Down + Enter selection and mouse hover (lines 379-392). New commands just join
`SLASH_COMMANDS` in `src/lib/assistant-slash.ts` and get a `case` in
`runSlashCommand`. No new menu UI is needed.

Menu polish (small, do alongside the new commands):
- Dismiss the menu once arguments start. `slashQuery` currently keeps matching on
  the first token, so the popup lingers while typing a `/write` brief. Return null
  from `slashQuery`/`matchSlash` once the input contains a space (command chosen,
  now typing args).
- Scope-aware list. Filter `SLASH_COMMANDS` by the panel's scope so the universe
  Plan surface hides scene/story-only commands (`/write`, `/rewrite`, `/copyedit`,
  `/catchup`, `/summaries`) and shows only what that scope supports (`/find`,
  `/who`, `/continuity-review`, `/review`, `/clear`, `/help`). Pass the allowed set
  (or the scope) into `matchSlash`.

New commands (all reuse existing endpoints/tools; add each to `SLASH_COMMANDS` and
`runSlashCommand`):
- **`/rewrite <how>`** - co-author a rewrite of the current selection to an
  instruction (distinct from `/write`, which drafts new prose). Reuses
  `/api/assistant/coauthor` with the selection as the `reference` (kind
  `selection`) and the instruction as the brief. Needs the editor selection, which
  the panel does not have today: add an optional `getSelection?: () => string |
  null` prop (and a `onReplaceSelection?` for insert-over-selection), wired from the
  Write page like the existing `onInsert`. Available only where a scene editor is
  open; absent on the Plan surfaces.
- **`/copyedit`** - kick a full mechanics + prose + lore review at the current
  scope, a fast path versus opening the review modal. Reuses the existing review
  flow: `reviewSceneWithAssistant` when a scene is in focus, else
  `startBackgroundReview` with all categories. Story-focus only.
- **`/who <name>`** - show a character/place sheet inline. Cheapest reuse: a
  templated chat send that names the entity and leans on the existing tool-enabled
  chat (`get_entity`); no new endpoint. Works in both story and universe scope (the
  tool is owner-scoped/universe-aware after Part A).
- **`/find <query>`** - search the universe and list quick hits. Templated chat send
  backed by the universe-scoped `search_text` tool (Part A, Layer 6). Optional
  follow-up: a dedicated endpoint that renders structured result links instead of a
  prose answer; not needed for the first cut. Works in both scopes.

Update `/help` automatically (it already lists `SLASH_COMMANDS`), and add the new
commands to the in-app help article (see Docs).

## Tests (write alongside each layer)
- **Unit:** new renderers (`renderUniverseFrame`/`renderUniverseOutline`/
  `renderUniverseBackbone`) and scope-based tier selection; backbone capping on a
  many-story universe. Reuse the `selectWithinBudget` test style. For Part B: the
  preceding-prose excerpt renders and is capped, and is absent when `precedingProse`
  is off or there is no preceding scene. For Part E: `slashQuery` returns null once a
  space is typed (menu dismisses for args), and `matchSlash` filters by scope (the
  universe scope hides scene-only commands); `slashArgs` returns the text after the
  command for `/write` and `/rewrite`.
- **Integration (real Postgres):** chat-history universe keying and isolation from a
  story conversation in the same universe; the CHECK rejecting both/neither set;
  tool scoping (`get_scene` reads another story in the universe but refuses a
  different universe / another user; `list_scenes` grouped by story;
  `find_appearances` cross-story with attribution; `search_text` in-universe only);
  the chat endpoint with `{ universeId }` and still with `{ storyId }`; 403 when the
  account Assistant is off; the migration applies cleanly. Part C: `/api/assistant/
  coauthor` still drafts from a brief (the `/write` path reuses it). Part D: a
  continuity-only review job runs the consistency pass without the per-scene passes;
  a universe-wide continuity pass stages a thread on the correct story's scene.
- **e2e (optional):** universe Plan page shows the Assistant tab when enabled and a
  message round-trips.

## Risks / follow-ups
- Write tools must resolve the owning `storyId` from the loaded scene, not
  `ctx.storyId` (undefined in universe scope) — get this right or suggestions
  misattribute.
- Universe-wide `list_scenes`/`search_text` return more than story-scoped; existing
  per-result caps and the tool-call budget bound it; watch per-turn cost on large
  universes (prompt caching helps).
- Out of scope / follow-ups: per-universe mute and universe `llm_config`;
  `universeId` on `assistant_usage` for per-universe cost; a cross-series recap;
  budget calibration of the universe-outline tier against a real multi-story corpus.

## Docs
Update `src/lib/docs/planning.md` (the Plan pages' help topic) to describe the
universe Assistant tab and its cross-story reach, and note the per-story Assistant
can now check continuity against the universe's other stories. Update the help that
covers the chat to list the slash commands, including the new `/write`, `/rewrite`,
`/copyedit`, `/continuity-review`, `/who`, and `/find` (the `/help` command already
lists them in-app, but the article should match). Optionally extend the Write-page
help to mention the preceding-scene continuity in the Write action. Not a blocker.

## Verification
- `npm run lint`, `npm run check`, `npm test` (unit + the integration suite where the
  sandbox has Postgres). State plainly in the PR what could not be run locally and
  let CI gate it.
- Manual, Assistant enabled for the account:
  - Story Plan page shows an Assistant pill next to Reference/History/Session; the
    thread is the same one as Write (send on Write, reopen Plan, it is there).
  - Universe Plan page shows an Assistant pill; its conversation is a separate,
    universe-level thread.
  - Cross-story continuity: in Story 2's Write Assistant, ask about an event/detail
    from Story 1 and confirm it can find and cite it (via `get_scene`/`search_text`),
    and that it grounds rather than inventing.
  - With the account Assistant disabled, no pill appears on either Plan page.
  - Part B: on a brand-new empty scene that follows an existing one, use the toolbar
    Write action with "continue from the previous scene" and confirm the draft
    actually continues the prior scene's events and matches its voice (it now has the
    preceding prose, not just a summary).
  - Part C: type `/write <brief>` in the chat and confirm a passage is drafted and
    can be inserted into the open scene.
  - Part E: the slash menu lists the scope's commands on `/` and dismisses once you
    type a space; `/rewrite <how>` rewrites the current selection; `/copyedit` kicks
    a review; `/who <name>` shows an entity sheet; `/find <query>` returns universe
    hits.
  - Part D: type `/continuity-review` from a story surface and confirm a continuity
    pass stages findings on the story's scenes; run it from the universe Plan surface
    and confirm a contradiction against another story is flagged on that story's
    scene.
