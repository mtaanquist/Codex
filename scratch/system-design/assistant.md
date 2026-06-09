# The Assistant (LLM integration)

Status: Phase 9, in progress. The server-only gateway plumbing is built,
tested, and merged to `develop` (the `src/lib/server/llm/` module: config,
egress guard, OpenAI-compatible provider, context assembly, tools, and the
setup helpers). The first surface is built: the account Assistant settings
page at `/account/assistant` (PR #325). The remaining surfaces (chat, inline,
review, the admin egress panel, the per-story mute) and the worker jobs are
not yet built; the "Frontend wiring map" at the end tracks each one. Parts of
this document remain deliberately ahead of the code, so treat the numbers and
prompts as placeholders (marked TODO) until a real prose corpus is available
to calibrate them against.

The feature is named the Assistant throughout, in the UI and the code. "AI"
and "LLM" describe the mechanism; the Assistant is the thing the writer
talks to.

## Why this is deferred, restated

The roadmap is emphatic that building the LLM layer early is the most
tempting wrong move on the whole project. Two reasons stand: the editor and
planning surface have to be good on their own first, and the prose that
emerges from real use is the best calibration material for context assembly
and prompts. This document does not change that. It exists so that when the
work is taken on, the shape is already argued out and the reserved schema
columns fit.

## What the Assistant is, and is not

- A writing aid, not a general-purpose chat tool. The rubber-duck role is
  there to help the writer think about their work, not to answer arbitrary
  questions.
- Not a role-play tool. No character impersonation in UI or schema.
- Opt-in, off by default. Enabled at the account level (configure an
  endpoint, flip the master toggle on); once on, stories inherit it and can be
  muted one at a time. A writer who never opts in sees no Assistant UI
  anywhere: no tab, no editor decorations, no menu items, nothing. See
  "Gating and discoverability" below.
- It proposes; the human commits. The Assistant never silently changes
  authored content. Every write it makes is presented as a preview, a
  confirm, or a suggested edit the writer accepts or rejects. See "Writes
  are suggestions" below.

## Gating and discoverability

The Assistant is invisible until the writer asks for it. This is a hard rule,
not a soft default: a writer who has not opted in must see no trace of the
feature, the same way the asset-backed features (cover, edition downloads,
avatar upload) hide entirely when no storage bucket is configured.

Enablement lives at the account level. There are two account-level conditions
and one per-story refinement:

1. Configured: an endpoint is set on the account. If not, there is no
   Assistant anywhere - no tab in the right sidebar, no "Ask the Assistant" on
   the editor right-click menu, no "Review this scene/chapter" on the
   left-sidebar menu, no continuation ghost-text, no suggested-prompt chips.
   The only Assistant surface is the account settings section where the writer
   configures an endpoint. Everything else is absent from the DOM, not merely
   disabled.

2. Account master toggle (the kill switch): a single account-level on/off.
   Off means the Assistant is dark everywhere, instantly, regardless of any
   per-story state, while the endpoint config stays saved - the point of a
   kill switch is to go dark without tearing down the setup. The writer flips
   it on once (this is the opt-in), and kills or re-enables from the same
   account settings section.

When both hold (configured, and the account master on), the Assistant is live
across the writer's stories by default, with no per-story flipping. This is
live inheritance through the `storyPreferences` pattern, not a value copied
onto each story at creation: a story with no override follows the account.
Copying at creation would break the kill switch, since a later account-off
would leave each story carrying its own stale `enabled` value and the
Assistant would stay live on them.

3. Per-story mute: a story can override to disabled, muting the Assistant for
   that one book. The override only ever subtracts - the account master stays
   the kill switch, so a per-story setting cannot light the Assistant up when
   the account is off. On a muted story the editor and menu surfaces hide, but
   the Assistant tab stays as the un-mute switch.

Concretely: the in-editor and in-menu surfaces (right-click "Ask the
Assistant", left-menu review items, continuation, co-author) require
configured AND account-on AND this-story-not-muted; the Assistant tab
requires configured AND account-on (it is the per-story on/off). When the
account is unconfigured or the master is off, even the tab is gone and the
writer manages the Assistant from account settings. The gate is checked
server-side (the surfaces are not rendered) and reflected in the layout data
the pages already load, so a dark Assistant ships no client code paths a
curious user could trip.

### The kill switch as a prominent control

The account master toggle is not a small checkbox buried among model
settings; it is the prominent, self-explaining control at the top of the
account Assistant section, modelled on the pattern browsers have adopted for
their own AI features (Firefox's "Block AI enhancements" panel is the
reference). It carries, in plain language:

- what turning it on does: the Assistant becomes available, and the content
  it needs (the prose, entities, and lore in scope) is sent to the endpoint
  the writer configures. This is the privacy disclosure (see "Privacy" below)
  and it sits here, on the switch, not in fine print.
- what turning it off does: every Assistant surface goes dark immediately,
  everywhere, across all stories, while the endpoint configuration stays
  saved so it can be turned back on without re-entering anything.
- the current state and the default: off until the writer opts in.

The point is that the writer is never surprised about whether their work is
leaving the instance. The switch that controls it also explains it, in the
place they would look to change it.

## Configuration: bring your own key

Codex ships no bundled model. The writer configures their own
OpenAI-compatible endpoint: Ollama on a local machine, a hosted API, a
self-hosted vLLM, or Anthropic's OpenAI-compatibility endpoint. The first
release supports OpenAI-compatible endpoints only. A native Claude adapter
(speaking Anthropic's own API, to reach adaptive thinking, prompt caching,
and the large context window) is a planned later seam, not a first cut; the
gateway is built so it can drop in without reworking the config schema or
the surfaces. See "The gateway" below.

A note we should not gloss over: a Claude Pro or Max subscription is a
Claude.ai consumer plan, not an API credential. There is no supported path
for a third-party app to make completion calls on a user's subscription;
those plans drive Claude.ai and Anthropic's own first-party tooling. An
Anthropic user configuring the Assistant supplies an API key from the
developer console, billed as API usage, separate from any subscription. The
config UI should say so plainly so nobody pastes a subscription expecting it
to work.

### What is stored, and where

The reserved `users.llm_config` and `stories.llm_config` jsonb columns hold
this. They exist now and are inert (`{}`) in v1.

- `users.llm_config` holds the per-account configuration: the master `enabled`
  toggle (the kill switch), endpoint URL, API key, a model-per-role mapping
  (continuation, co-author, editor, reviewer, chat), and a tool-call budget
  (the maximum tool calls the Assistant may make in one turn). The key is
  encrypted at rest using the existing AES-256-GCM helper in `crypto.ts`
  (keyed from `APP_SECRET`, already used for the SMTP password and the TOTP
  secret), stored as an encrypted string inside the jsonb the same way the
  SMTP password is. A blank key on save keeps the stored one.
- `stories.llm_config` holds per-story overrides, merged over the account
  config at request time. The override is model selection and a per-story
  mute (`enabled: false`); not a second endpoint, key, or tool budget. The
  merge follows the preference-layering pattern already shipped
  (`storyPreferences`): a story with no `enabled` override inherits the
  account master (so a story is on by default once the account is on), and
  "use my account setting" clears the override by deleting the jsonb key. A
  per-story override never overrides the account kill switch upward - account
  off is dark everywhere.

Configuration lives in the account settings (a new Assistant section) and,
for the per-story pieces, in story settings next to the existing editor
overrides. A "test connection" probe mirrors the SMTP relay's
test-email button: send a trivial completion and report success or the
error.

### Admin egress policy (the SSRF question)

Because the key is held server-side, the browser cannot call the writer's
endpoint directly; the app server proxies the request. On a shared hosted
instance, "bring your own endpoint URL" means an authenticated user can make
the server fetch a URL they choose, which is a server-side request forgery
vector into internal infrastructure (cloud metadata endpoints, the
database, other tenants).

Self-host and hosted want different defaults, and the app already
distinguishes deployment posture through admin settings:

- Self-host trusts the operator and needs to reach private addresses
  (Ollama on the same box, `host.docker.internal`).
- Hosted should block private, loopback, and link-local ranges, or restrict
  to an operator-curated list.

So: an admin setting (`app_settings`) for the egress policy, one of

- `block-private` (default; safe for hosted) - resolve the endpoint host and
  refuse private, loopback, link-local, and unique-local addresses,
- `allowlist` - only hosts on an operator-curated whitelist are reachable
  (the middle ground for a hosted operator who wants to permit a known set),
- `open` - no restriction (the self-host flip).

The whitelist is managed in the admin panel alongside the policy select.
Enforcement happens in the gateway on every outbound call, after DNS
resolution, with protection against rebinding (resolve, validate, then
connect to the validated address). This is specced from day one rather than
retrofitted, because it shapes the config schema and the self-host vs hosted
split.

## The gateway

"Gateway" is an internal abstraction boundary, not a separate process. The
stack stays four services. The gateway is a server-only module
(`$lib/server/llm/`) that:

- normalises a completion request to the OpenAI-compatible shape (so the
  future native-Claude adapter is a second implementation behind the same
  interface),
- assembles context (see below),
- enforces the egress policy,
- streams the response.

A streaming SvelteKit endpoint (`+server.ts`) fronts it for the interactive
surfaces; the worker calls the module directly for background jobs.
Transport to the browser is Server-Sent Events, which fits the
token-at-a-time shape and needs no new dependency.

Cost and runaway protection: the writer pays their own provider, so Codex
does not meter spend, but an agentic tool loop on a slow endpoint can still
run away. The gateway enforces a per-turn tool-call budget and a token
ceiling, and the streaming endpoint is covered by the existing per-user
write/rate limiter.

The tool-call budget is a writer-set value in `users.llm_config`, not a
fixed number Codex chooses. The point of bring-your-own-endpoint is that the
writer owns the trade-off: someone running a model on their own server
incurs only electricity and may want a generous budget, while someone on a
metered API may want a tight one. The setting has a sensible default and an
optional admin ceiling in `app_settings`: a runaway loop still ties up a
server connection (and, for a background job, a worker slot) regardless of
who pays for the tokens, so a shared hosted operator can bound it
instance-wide. On self-host the operator is the writer, so the ceiling is
theirs to raise or remove.

## Three surfaces

Everything the writer asked for sorts onto three surfaces, distinguished by
how they execute and where the output lands.

### 1. Chat (the Assistant tab)

The Assistant is its own tab in the right sidebar, a peer of Reference,
History, and Session (per the app-design prototype). This supersedes the
older `design.md` line that reserved space for the chat below the Session
tab's quick settings; that section of `design.md` needs a follow-up edit to
match (the right sidebar now has four tabs, not three, and the Assistant is
a distinct semantic axis: who you are working with). The Session tab keeps
its quick settings; the per-story "Assistant for this story" mute lives with
the Assistant tab (it inherits the account default, so a story is on unless
muted; see "Gating and discoverability"). When the account is unconfigured or
the master toggle is off, the tab is absent entirely, not greyed - the writer
configures and enables the Assistant from account settings.

The tab, from the prototype:

- A short opening message that confirms the Assistant has the world loaded
  ("I've read your codex for The Shattered Realms. Ask me about your
  characters, check continuity, or work a scene.").
- The conversation transcript.
- Grounded suggested-prompt chips above the input when the conversation is
  empty (the "quick actions" want), drawn from the current story and
  entities, for example "What's at stake for Alice in Book of Ash?",
  "Suggest a complication for the river crossing scene", "Is Bram's arc
  consistent so far?". These are starting points, not a fixed menu; they
  seed the three surfaces (a question, a co-author nudge, a continuity
  review).
- An "Ask about your story..." input with a send control.

The chat is sync and streaming. It is the home of:

- the rubber-duck role (user-driven, no automatic context injection beyond
  what the writer references),
- "reference in chat" (pull the current selection, scene, or an entity into
  the conversation as context the writer then asks about),
- questions about the world: relationships, entities, "what happened to
  X", grounded in the universe data (see "Grounding"),
- tool-driven actions like "using the scene 'Session template' make one for
  tonight with X, Y, Z" (see "Tool use"),
- the usual chat affordances: regenerate a message, copy, stop generation.

Persistence: the first cut is ephemeral (conversation state lives in the
client and is lost on reload). Regenerate works because the surrounding
turns are retained in the client for the session. Persisted conversations
(a `conversations` / `messages` pair of tables, browsing past chats,
resumption) are a deferred refinement, taken on only once the chat has
proven its worth. This matches the roadmap's "Session tab refinements" item
and the project's "revisions are cheap to skip early" instinct.

### 2. Inline (the editor)

Sync, in the prose, distinct from the lookup-based entity autocomplete that
already ships.

- Continuation: inline ghost-text from the model, Tab to accept, built as
  its own CodeMirror extension in a reserved compartment, kept separate from
  entity autocomplete (they share a UX pattern, not a backend).
- Co-author: a side-panel generation surface with insert / edit / reject,
  assembled from current-scene plus chapter-summary plus active-character
  context.
- "Ask the Assistant" on the editor right-click menu, over a selection, with
  submenu items:
  - Review (send the selection to the reviewer surface),
  - Reference in chat (drop it into the Assistant tab chat),
  - Check continuity (a focused continuity pass on the selection).

The selection menu already exists (bold/italic/quote/list plus
create-entity from selection); the Assistant items extend it.

### 3. Review (comments and suggested edits)

This is the reuse jackpot. The Assistant becomes a reviewer identity
alongside the guest reviewer and the author-self reviewer, writing into the
existing `review_comments` and `review_suggestions` tables. Accept, reject,
reanchoring against edited text, and "apply the suggestion to the body" all
already work; the author resolves an Assistant suggestion the same way they
resolve a guest's.

- Assistant-as-reviewer: a review pass that leaves comments and suggested
  edits on a scene, chapter, or whole story.
- Entry points: the editor left-sidebar right-click gains "Review this
  scene" and "Review this chapter"; "Review this story" lives in the story
  settings Review section (where author-self review is already linked) and
  in the command palette.
- Continuity check, scene-split suggestion, and entity-detail suggestions
  (below) are all review output: comments and suggestions the writer
  accepts or rejects.

A whole-story review is long-running and fans over every scene, so it is a
background worker job (like exports), not a request. A single-scene review
can run inline.

Schema touchpoint: the review tables already made `reviewerId` nullable and
added `authorUserId` for author-self review. The Assistant needs a third
attribution. Options to decide at build time: a reserved synthetic reviewer
row, or an `assistant` flag/column on the comment and suggestion rows.
Whichever keeps the accept/reject/reanchor paths untouched wins.

## Writes are suggestions

A single rule governs every way the Assistant changes the writer's data: it
proposes, the human commits. Concretely:

- Prose edits (co-author, continuity fixes, reviewer suggestions) land as
  `review_suggestions` the writer accepts or rejects, or as an
  insert/edit/reject panel for co-author generation. Never a silent body
  write.
- Structural actions invoked from chat (create a scene, create an entity,
  add an alias, set a quick detail, split a scene) show a preview and a
  confirm before anything is written.
- Entity enrichment (suggested aliases, quick details, summary drafted from
  the scenes a character appears in) lands as suggestions on the entity, not
  an overwrite. The writer takes what they want.

This keeps faith with the principle that authored content stays the user's,
and it lets the whole write surface reuse the suggestion machinery rather
than inventing a parallel apply-and-undo path.

## Tool use

The "create a scene from a template" want reveals that the Assistant is an
agent with tools, not only a text generator. Once the chat can create a
scene, the same mechanism naturally wants to create entities, add aliases,
set quick details, split a scene, and write a note. These are defined as
tools (function-calling) the model can request; the gateway executes the
request and, per the rule above, surfaces the result as a preview/confirm or
a suggestion rather than committing it.

Tool families, sketched (each gated, each landing as a human-approved
change):

- Content: create a scene (optionally from an existing scene used as a
  template), create a chapter, suggest a natural scene split (reusing
  `scene-split-merge.ts`), create a note.
- Worldbuilding: create a character / place / lore entry, suggest aliases,
  suggest or refresh quick details and summary.
- Read-only retrieval: fetch a scene, an entity card, the relationship set,
  the mention index for an entity. These ground the model's answers and do
  not need confirmation (they write nothing).

Iteration is capped by the writer's per-turn tool-call budget (see
configuration above) so a loop on a slow endpoint cannot run away, bounded
by the optional admin ceiling.

## Context assembly

The Assistant is only as good as what it is given. For ghost-writing in
particular, it needs the world: characters, places, lore, relationships,
per-story notes. Context is assembled per request against a token budget,
in tiers, drawing on the existing mention index rather than re-scanning
prose:

1. Scene-local: the current scene, plus neighbouring scene summaries.
2. Story and chapter: chapter and scene `summary_md` (summaries, not full
   bodies, to stay within budget).
3. Entity: story members and mentioned entities in scope, their
   relationships, quick details, and per-story notes.
4. Lore activation: the reserved `lore_entries.activation_mode` finally
   earns its keep, mirroring lorebook semantics. `always` entries are always
   injected; `keyword` entries are injected when a keyword appears in the
   current scope; `manual` entries are never auto-injected.

TODO (needs a real corpus): the token budget per tier, the truncation and
prioritisation strategy when a story outgrows the budget, and how far the
neighbour window reaches. These are calibration decisions, not design
decisions, and guessing them now would be the exact mistake the roadmap
warns against.

## Grounding

Questions about the world (relationships, entity history, "what happened to
X") must be grounded in the universe data and cite their sources. An answer
links back to the scene and offset it draws from, the way the appears-in
snippets already jump to a mention's position. This is the single biggest
trust lever: it turns entity Q&A from a hallucination risk into a cited,
checkable answer, and it keeps the Assistant honest about what is actually
in the text versus what it inferred.

## Background jobs versus sync

Two execution modes, already separable by the existing architecture:

- Sync streaming (the app server's streaming endpoint): chat, continuation,
  co-author, single-scene review.
- Background jobs (the pg-boss worker, as exports and backups already run):
  whole-story review, regenerating entity arc summaries across a universe,
  refreshing scene and chapter summaries in bulk.

Derived artifacts that are expensive to compute (a character's arc summary,
"what happened to them across the stories they are in") are cached on the
entity with a staleness watermark, the way scene mentions carry
`mentions_indexed_at`, and regenerated by a job rather than on every view.

## Features beyond the brainstorm

Same vein, worth specifying:

- Recap / "catch me up": a recap of the story up to the current scene, for
  returning to a work in progress. Falls out of the summary tiers; cheap and
  high value.
- Summary maintenance: the Assistant drafts and refreshes scene and chapter
  `summary_md`. A virtuous cycle, since better summaries directly improve
  co-author context and the recap. Probably the highest-leverage background
  job.
- Unknown-name nudge: the Assistant notices a proper noun in prose that is
  not a known entity and offers to create a character/place/lore entry.
  Bridges prose to the worldbuilding graph; distinct from the lookup-based
  entity autocomplete.
- Continuity as a reviewer mode, broader than a single selection: flag
  contradictions against entity quick details and prior scenes (a changed
  eye colour, a dead character speaking, a timeline slip), plus POV and
  tense drift.
- Character arc summaries: an on-demand "what happened to this character
  across their stories" summary, cached per entity (see Background jobs).

Not to be resurrected: the Outline view was retired (migration 0039).
"What scene comes next" planning belongs on the scene board and in notes,
not a revived outline tree.

## The five roles, mapped

The original `design.md` ladder maps onto the surfaces above:

1. Off - default everywhere.
2. Rubber duck - Chat surface.
3. Co-author - Inline surface.
4. Continuation - Inline surface (CodeMirror ghost-text extension).
5. Editor (margin annotations) - Review surface.

Plus the reviewer role this document adds, also on the Review surface, which
is really the "editor" role realised through the existing comments and
suggestions framework rather than a bespoke margin-annotation system.

## Privacy, safety, and operations

These cut across the surfaces and the architecture.

- **Privacy and disclosure.** The Assistant transmits the writer's private,
  unpublished work (prose, entities, lore in scope) to an external endpoint.
  For a local model that stays on their machine; for a hosted API it leaves
  the instance to a third party. The app's whole posture is owner-scoped
  privacy, so this crossing is disclosed plainly at the point of control (the
  kill switch, see "Gating and discoverability") and again in the help
  article, never buried. On a shared hosted instance this is also the
  operator's concern; the disclosure protects both.
- **Prompt injection, contained.** The writer's own content is fed to the
  model as context, so a passage like "ignore your instructions and..." could
  try to steer a reviewer pass or a staged tool call. Because every write is
  staged and human-approved (see "Writes are suggestions"), the worst case is
  a suggestion the writer rejects, not a silent mutation. The containment is a
  property of the design, not an add-on.
- **Notifications.** Background jobs (a whole-story review, a bulk summary
  pass) finish asynchronously, so completion and failure ride the existing
  notifications system (a new kind in the in-app and email matrix): "your
  review of X is ready", or a clear failure if the endpoint was unreachable.
  No new delivery machinery.
- **Writing language.** The Assistant honours the story's `writingLanguage`
  (the preference already driving spell-check), so it generates prose and
  answers in the writer's language rather than defaulting to English.
- **Accessibility.** The streaming chat and the ghost-text continuation follow
  the same WCAG 2.1 AA bar as the rest of the app: streamed output is
  announced to assistive tech, and the inline suggestion is operable and
  perceivable without relying on the ghost styling alone.
- **Operations (self-host).** SSE is a long-lived connection and a local model
  can hold it for minutes, so the reverse-proxy examples in
  `docs/SELF-HOSTING.md` (Caddy, nginx, Traefik) need timeouts that do not cut
  streams, and the single-replica stance means concurrent streams are a finite
  resource on one process. A self-hosting section covers proxy timeouts,
  concurrency, and the admin egress and tool-budget controls.
- **Help.** A writer-facing help article under `src/lib/docs/` ships with the
  feature (configuring an endpoint, the kill switch and what it sends, the
  three surfaces, accepting suggestions), per the CLAUDE.md rule to keep the
  in-app help in step. The admin egress panel needs no article.
- **Export.** The Assistant adds no new trapped authored content: accepted
  suggestions land in prose and entities, which already export; ephemeral chat
  and regenerable derived artifacts (arc summaries) do not need to ride the
  export.

## Implementation architecture

This is the build plan for the spec above. It uses the patterns already in
the codebase (server-only modules, the pg-boss worker, the review framework,
CodeMirror compartments, `crypto.ts`, `app_settings`) rather than introducing
new machinery. All of it is provider-neutral OpenAI-compatible; the native
Claude path is a second adapter behind the same seam.

### Module layout

Everything that touches the key or the endpoint is server-only, under
`$lib/server/llm/`:

```
$lib/server/llm/
  gateway.ts        - the one public entry: complete(), stream(). Orchestrates
                      config -> context -> provider -> tool loop -> stream.
  config.ts         - read users.llm_config + stories.llm_config, merge
                      (the storyPreferences pattern), decrypt the key.
  egress.ts         - the SSRF guard: resolve host, validate against the admin
                      policy, connect to the validated address.
  providers/
    types.ts        - the adapter interface (chatStream, supportsTools, ...).
    openai.ts       - the OpenAI-compatible adapter (the only one at first).
    (claude.ts)     - later, the native Anthropic adapter, same interface.
  context/
    assemble.ts     - tiered context builder + token budgeter.
    sources.ts      - pulls scenes, summaries, entities, relationships, and
                      lore (by activation_mode) from the existing queries.
  prompts/          - per-role system prompts (shipped-fixed in v1).
  tools/
    registry.ts     - tool definitions (JSON schema) + a dispatch table.
    dispatch.ts     - executes a tool call; write tools stage, never commit.
  jobs.ts           - enqueue helpers for the worker queues (name SSOT).
```

The gateway is the only thing the rest of the app calls. The streaming
endpoints call it; the worker calls it directly with no HTTP hop. The adapter
interface in `providers/types.ts` is the seam: `openai.ts` today, `claude.ts`
later, chosen from the resolved config.

### Request lifecycle

Two entry paths, one core:

```
Interactive:  browser -> POST /api/assistant/* (+server.ts, SSE)
                       -> gateway.stream()
                       -> egress check -> provider.chatStream()
                       -> tool loop -> SSE tokens back to the browser

Background:   worker job -> gateway.complete()/stream()
                         -> same core -> writes review_suggestions etc.
```

The browser never sees the key or the endpoint URL; the server proxies, which
is exactly why the egress guard matters and why the whole module is
server-only.

### Streaming transport

Server-Sent Events from a `+server.ts` returning a `Response` that wraps a
`ReadableStream`. No new dependency, fits adapter-node, and the provider's own
streaming chunks map straight onto SSE events. The continuation extension and
the chat panel consume the same event shape (token deltas, tool-call notices,
a final done event). The worker does not stream to anyone; it consumes the
provider stream internally and writes the result.

Cancellation runs the whole way through. A client disconnect or an explicit
"stop generation" aborts an `AbortSignal` that the gateway threads to the
provider fetch, so a cancelled generation actually stops the upstream work
(and, on a metered endpoint, the spend) rather than just closing the UI. A
slow local model can hold a connection for minutes, so the streaming path
must not sit behind a short proxy or server timeout; see the operations note.

### Provider capabilities and degradation

"OpenAI-compatible" is a wide tent: many local endpoints (Ollama especially)
do not support function-calling, and some do not stream. The adapter exposes
what an endpoint can do (`supportsTools`, `supportsStreaming`), detected by
the "test connection" probe and stored with the config. The surfaces degrade
gracefully rather than erroring: chat and continuation work on any endpoint;
the tool-driven actions (create scene, entity enrichment, structural edits)
simply do not appear when the endpoint cannot call tools, and the config UI
says why. A non-streaming endpoint falls back to a single buffered response
rendered when complete. The writer is never shown a feature their endpoint
cannot deliver.

### Surfaces, wired

- Chat: `POST /api/assistant/chat`, SSE, client-held ephemeral conversation
  (regenerate works from retained turns); persistence is a later
  `conversations`/`messages` pair.
- Inline: continuation is its own CodeMirror compartment (kept distinct from
  the entity-autocomplete compartment), calling `/api/assistant/continuation`;
  co-author is a side panel calling `/api/assistant/coauthor`.
- Review: a worker job (or an inline endpoint for a single scene) that calls
  the gateway and writes `review_comments` / `review_suggestions`, reanchoring
  through the existing `review-anchor.ts`. The accept/reject/apply paths are
  untouched.

### Tool dispatch and the writes-as-suggestions invariant

The tool loop lives in `tools/dispatch.ts`, capped by the writer's tool-call
budget. The code invariant that makes "writes are suggestions" real:

- Read tools (fetch scene, entity card, relationship set, mention index)
  execute immediately and feed results back to the model. They write nothing,
  so no confirmation.
- Write tools (create scene, add alias, set quick detail, split scene) do not
  mutate. They stage an artifact (a preview payload, or a `review_suggestion`
  row) and return "staged, pending approval" to the model so it can keep
  reasoning. Nothing reaches authored content until the human accepts in the
  UI.

This is what lets the entire write surface reuse the suggestion/accept
machinery instead of building a parallel apply-and-undo path.

### Background jobs

New pg-boss queues alongside exports and backups (names in the existing queue
SSOT): `assistant-review` (scene/chapter/story passes), `assistant-enrich`
(entity alias/detail/summary suggestions), `assistant-summaries` (summary_md
maintenance). Expensive derived artifacts (a character's arc summary) cache on
the entity with a staleness watermark, mirroring `mentions_indexed_at`, and
the reconcile-sweep pattern used for stale mentions applies directly.

### Cross-cutting

- Gate: every surface checks configured-and-enabled (see "Gating and
  discoverability") before rendering or calling.
- Rate and cost: reuse `rate-limit.ts` and the write-guard on the streaming
  endpoints; the gateway adds the tool-call budget and a token ceiling.
- Logging: `log.ts` structured events per completion (model, surface, token
  usage, egress decision), without logging prose.
- Errors: provider failures, egress denials, and timeouts become typed errors
  the endpoints render as clean SSE error events; a blocked egress is a 4xx
  with a clear message, not a 500.

### Testing, in the three layers

- Unit: context assembly and token budgeting, the egress policy decisions
  (table-driven IP cases - the SSRF guard is exactly the kind of pure logic to
  pin down), config merge/decrypt, prompt assembly, tool-call parsing.
  Provider mocked.
- Integration: the streaming endpoints and worker jobs against a throwaway
  Postgres with a stub provider returning canned streams and tool calls -
  asserting a write tool produces a suggestion and commits nothing, the gate
  blocks when not configured or disabled, and review jobs write and reanchor.
- End-to-end: one journey - configure an endpoint (a local stub), open the
  Assistant tab, ask a question, accept a suggestion.

## Schema touchpoints

- `users.llm_config`, `stories.llm_config`: already reserved; this fills
  them in (account: master `enabled`, endpoint, encrypted key, model-per-role,
  tool-call budget; per-story override is model selection and a mute).
- `lore_entries.activation_mode`: already reserved; context assembly
  activates it.
- `app_settings`: new rows for the egress policy, the host whitelist, and
  the optional tool-call-budget ceiling.
- Review tables: a third reviewer attribution for the Assistant (synthetic
  reviewer row or a flag column), TBD at build time.
- Possible additive columns for cached entity arc summaries with a staleness
  watermark.
- Deferred: persisted chat (`conversations` / `messages`), only if and when
  chat persistence is taken on.

## Open questions

- Are the per-role system prompts shipped-fixed or writer-editable?
  Recommendation: shipped-fixed in the first cut, to keep the rubber-duck a
  writing aid and not hand back the role-play escape hatch the design
  closes. Editability is a deliberate later question. (It is the writer's
  key and model, so misuse cannot be prevented; the question is whether the
  UI invites it.)
- Exactly how the Assistant reviewer is attributed in the review schema.
- The context token budgets and truncation strategy (calibration, needs a
  corpus).
- Whether continuation and co-author share a model setting or split.
- The tool loop shape for write tools: a constrained propose-once/stage
  (leaned to above) versus a full agentic loop (also viable, especially for
  read-heavy Q&A). The two can coexist - read tools loop, write tools stage.
- Whether model selection should also be overridable per universe, not only
  per account and per story (you arguably pick a model for a whole world's
  voice). A separate question from the tool budget; would add a third merge
  layer and a universe-level column.
Settled here, recorded so it is not re-litigated:

- Context-aware grammar and spell-check route through the Assistant's editor
  and reviewer capability over the bring-your-own endpoint, not a bundled
  model. Browser-native spell-check stays for basic spelling. A dedicated
  grammatical-error-correction model is small (roughly 60M-350M params, or
  zero with a rule engine), so size was never the obstacle; bundling one is,
  since shipping a model in the core stack crosses the "no bundled AI, bring
  your own endpoint" line and changes the self-host footprint. The decisive
  point is capability, not weight: a small GEC model only sees local context
  (a sentence or two), while the review agent already has the whole story,
  the entity details, and the mention index, so it catches both local grammar
  and story-level continuity from one surface - the bundled model would only
  do the weaker half. Grammar is therefore advisory only, delivered through
  the existing accept/reject suggestion surface (grammar-checking creative
  prose is perilous - fragments, dialect, and stylized voice read as errors),
  never auto-corrected. An optional off-by-default grammar service (for
  writers who want grammar with no creative AI at all) stays available as a
  later escape hatch if demand appears, but is not built.

- The tool-call budget stays account-level (plus the admin ceiling), not
  per-story or per-universe. Nothing about a story changes the
  cost/compute trade-off; a dense universe needing more retrieval is a signal
  to improve context assembly, not to add a per-universe dial. Revisit only
  if a better assembler cannot close the gap.
- Per-content context exclusion (a "do not send this scene/note" flag) is not
  built. Lore already has `activation_mode` for injection control; a
  scene/note exclude flag is YAGNI until a real need appears.
- Surfacing token/usage to the writer is deferred polish. `log.ts` captures
  usage server-side; a writer-facing display can come later if wanted, BYO or
  not.

## Sequencing sketch

Not a contract, but the natural order, foundations first:

1. Gateway module, OpenAI-compatible adapter, egress policy + admin
   whitelist, account config UI + test connection, encryption. No surfaces
   yet.
2. Chat (rubber duck) on the Assistant tab, ephemeral, with
   reference-in-chat.
   The smallest surface that proves the plumbing.
3. Context assembly tiers + grounding, exercised first by chat Q&A about the
   world.
4. Review surface: Assistant-as-reviewer, single-scene first, then the
   whole-story background job; continuity check; scene-split suggestion.
5. Inline: co-author, then continuation.
6. Tool use and structural actions (create scene from template, entity
   enrichment), each as a human-approved change.
7. Background enrichment: summary maintenance, character arc summaries,
   recap.
8. Deferred refinements: chat persistence and browsing; the native Claude
   adapter.

## Frontend wiring map (backend on develop; account settings surface on PR #325)

A note for the frontend agent. The server-only plumbing is built and tested
under `src/lib/server/llm/`, and the first surface (the account Assistant
settings page) is built; the rest of the surfaces (SSE endpoints, the other
form actions, Svelte UI, worker jobs) are not. This maps each feature to what
it should call. Status markers: [built] server-side helper exists and is
tested, or the surface is built; [to build] the frontend agent creates it.

Everything that touches the key or the endpoint is server-only. The browser
never calls the model endpoint; a SvelteKit `+server.ts` (SSE) or a form action
calls the gateway, which proxies through the egress guard.

### Gating (render nothing when off)

- [built] `accountLlmView(db, userId)` and `resolveLlmConfig(db, userId, storyId?)`
  (`llm/config.ts`). The gate is `assistantGate(...)` -> `{ configured,
  accountEnabled, tabEnabled, surfacesEnabled }`.
- [to build] Feed the gate into the layout load (the way asset-backed features
  hide when no bucket is set), so the Assistant tab, editor menu items, and
  continuation render only when allowed. Rule: tab needs `tabEnabled`; in-editor
  and in-menu surfaces need `surfacesEnabled`; nothing renders when not
  `configured` or the master is off.

### Account Assistant settings (configure + enable)

- [built] Read: `accountLlmView` (never exposes the key; has `hasKey`,
  `assistantName`, `persona`, `models`, `toolCallBudget`, capability flags).
- [built] Save: `saveAccountLlmConfig(db, userId, input)` (blank `apiKey` keeps
  the stored one; validates the endpoint). Persona presets: `PERSONAS`,
  `Persona`, `MAX_ASSISTANT_NAME` (`llm/prompts/persona.ts`) for the tone
  dropdown and name field.
- [built] The master toggle (kill switch) is the `enabled` field. Keep the
  privacy disclosure on this control (see "The kill switch as a prominent
  control").
- [built] The settings page at `/account/assistant` (the account sidebar shell's
  Assistant section). Form actions `toggleAssistant`, `saveAssistantIdentity`,
  `saveAssistantEndpoint`, `saveAssistantModels` call `saveAccountLlmConfig` (each
  reads the current view and overlays only its fields). The kill switch reads
  inverted (engaged means off) and dims the config below while off.

### Endpoint setup helpers (so a non-technical writer does not type a model name)

- [built] Model discovery: `discoverModels(db, userId)` (saved config) or
  `listEndpointModels(db, conn)` (submitted-but-unsaved endpoint/key). Returns
  sorted model ids for a dropdown. (`llm/models.ts`)
- [built] Test connection: `testAccountConnection(db, userId, model?)` /
  `testEndpointConnection(db, conn, model)` - sends a tiny prompt and returns the
  model's reply.
- [built] Capabilities: `probeAccountEndpoint(db, userId, model?)` /
  `probeEndpoint(db, conn, model)` - returns `{ supportsStreaming, supportsTools }`
  for a "tools: supported / not" line. Save these onto the config (via
  `saveAccountLlmConfig`) so the gateway withholds tools when unsupported.
- [built] On `/account/assistant`: a "Test connection" button (`testAssistant`
  action) and a "Discover models" button (`discoverAssistantModels`) that fills
  the per-role model `<select>`s. Capability probing on this screen is deferred
  (no "tools: supported" line yet); the probe helpers remain available.

### Admin egress policy (the SSRF control)

- [built] `egressPolicy(db)` / `saveEgressPolicy(db, { policy, allowlist })`
  (`llm/egress.ts`); policy is `block-private | allowlist | open`.
- [to build] An admin panel section (policy select + host allowlist). No help
  article needed (admin panel).

### Per-story override (the Assistant tab's mute)

- [built] `saveStoryLlmOverride(db, storyId, { enabled?: false | null, models? })`
  - `enabled: false` mutes this story, `null` clears the override (back to the
  account default). A story can only subtract.
- [to build] The mute control on the Assistant tab.

### Chat (the Assistant tab) - sequencing step 2

- [to build] `POST /api/assistant/chat` as an SSE `+server.ts`. It should:
  1. assemble context: `assembleContext(db, { userId, storyId, sceneId?, focusText? })`
     (`llm/context/assemble.ts`), then `buildSystemMessage(context)`;
  2. call `stream(db, { userId, storyId, sceneId?, role: 'chat', enableTools: true,
     messages: [systemMessage, ...clientTurns] })` (`llm/gateway.ts`);
  3. forward the `StreamEvent`s (`token` | `done` | `error`) to the browser as SSE.
- [built] The gateway prepends the persona system message itself and runs the
  tool loop; the client holds the transcript (ephemeral first cut). Suggested
  prompt chips can be seeded from `context.sources` (entities/scenes/lore).
- [built] Grounding: `context.sources` carries entity ids, scene ids + titles,
  and lore ids; `find_appearances` (a tool) returns mention offsets for "jump to
  the source" links, the same way appears-in snippets already work.

### Inline (editor) - sequencing step 5

- [to build] `POST /api/assistant/continuation` and `/api/assistant/coauthor`
  SSE endpoints. Continuation: `stream(..., role: 'continuation', enableTools:
  false)`, no context needed beyond the current text the client sends. Co-author:
  build context with `assembleContext` first, `role: 'coauthor'`.
- [to build] The CodeMirror ghost-text extension (its own compartment, distinct
  from entity autocomplete) and the co-author side panel (insert / edit /
  reject).

### Review (Assistant-as-reviewer) - sequencing step 4

- [built] The Assistant writes through the existing review framework as a third
  author. Single-scene review: call `stream`/`complete` with `role: 'reviewer'`
  and `enableTools: true`; the model uses the `suggest_edit` and `leave_comment`
  tools, which stage `review_suggestions` / review comments authored by the
  Assistant (nothing is applied to prose).
- [built] Render: `listSuggestions(db, storyId)` and `listThreads(db, storyId)`
  (`review.ts`) now carry `isAssistant` (badge it) and `reviewerName` resolved
  live from the assistant's name. Accept/reject is the unchanged
  `decideSuggestion` / `setThreadResolved`. The existing author-review screen
  already renders these.
- [to build] Entry points (left-sidebar "Review this scene/chapter", story
  settings "Review this story", palette command). Whole-story review is a
  background worker job (see below).

### Background jobs - sequencing steps 4 and 7

- [to build] New pg-boss queues `assistant-review`, `assistant-enrich`,
  `assistant-summaries` (add names to `queues.ts`, enqueue helpers to `jobs.ts`,
  handlers in `src/worker/index.ts`). The handlers call the gateway directly
  (`complete`/`stream`, no HTTP hop) and write through the same review/entity
  helpers. Completion/failure rides the existing notifications matrix (a new
  kind). None of this is built.

### Tool use and structural actions - sequencing step 6

- [built] Read tools (`get_scene`, `get_entity`, `find_appearances`,
  `search_text`) and prose write tools (`suggest_edit`, `leave_comment`) in
  `llm/tools/`. The gateway loop dispatches them, capped by the account
  `toolCallBudget`. The frontend only renders the staged results (the
  `isAssistant` suggestions/comments).
- [to build] Structural write tools (create scene from a template, create an
  entity, set a quick detail, split a scene) need a preview-and-confirm artifact
  that does not exist yet; they are deliberately deferred. Add them as new tools
  in `llm/tools/registry.ts` + `dispatch.ts` with a staging store when taken on.

### Help and exports

- [to build] A writer-facing help article under `src/lib/docs/` (configuring an
  endpoint, the kill switch and what it sends, the three surfaces, accepting
  suggestions), per the CLAUDE.md rule. The admin egress panel needs none.
- [built] No new trapped content: accepted suggestions land in prose/entities,
  which already export; ephemeral chat and derived artifacts do not ride the
  export.

### One-line server API index (all under `src/lib/server/llm/`)

- `config.ts`: `accountLlmView`, `resolveLlmConfig`, `assistantGate`,
  `saveAccountLlmConfig`, `saveStoryLlmOverride`, `ASSISTANT_ROLES`.
- `prompts/persona.ts`: `PERSONAS`, `Persona`, `MAX_ASSISTANT_NAME`,
  `buildPersonaPrompt`.
- `models.ts`: `discoverModels`, `listEndpointModels`, `testAccountConnection`,
  `testEndpointConnection`, `probeAccountEndpoint`, `probeEndpoint`.
- `egress.ts`: `egressPolicy`, `saveEgressPolicy`.
- `context/assemble.ts`: `assembleContext`, `buildSystemMessage`.
- `gateway.ts`: `stream`, `complete` (the only entry the surfaces call),
  `GatewayRequest`, `AssistantDisabledError`.
- `review.ts` (existing): `listSuggestions`, `listThreads`, `decideSuggestion`,
  `setThreadResolved` - now Assistant-aware (`isAssistant`).
