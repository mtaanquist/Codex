# The Assistant (LLM integration)

Status: design sketch for Phase 9. Nothing here is built. This document
expands the deferred "AI" notes in `design.md` and the single Phase 9
roadmap bullet into a working spec. It is deliberately ahead of the code,
so treat the numbers and prompts as placeholders (marked TODO) until a real
prose corpus is available to calibrate them against.

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
- Off by default for every account and every story. A writer who never
  configures an endpoint never sees an Assistant surface.
- It proposes; the human commits. The Assistant never silently changes
  authored content. Every write it makes is presented as a preview, a
  confirm, or a suggested edit the writer accepts or rejects. See "Writes
  are suggestions" below.

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

- `users.llm_config` holds the per-account configuration: endpoint URL, API
  key, and a model-per-role mapping (continuation, co-author, editor,
  reviewer, chat). The key is encrypted at rest using the existing
  AES-256-GCM helper in `crypto.ts` (keyed from `APP_SECRET`, already used
  for the SMTP password and the TOTP secret), stored as an encrypted string
  inside the jsonb the same way the SMTP password is. A blank key on save
  keeps the stored one.
- `stories.llm_config` holds per-story overrides, merged over the account
  config at request time. Per the design line, the override is model
  selection (and the per-story on/off toggle), not a second endpoint or
  key. The merge follows the preference-layering pattern already shipped
  (`storyPreferences`), so "use my account setting" clears the override by
  deleting the jsonb key.

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
run away. The gateway enforces a per-turn tool-call cap and a token ceiling,
and the streaming endpoint is covered by the existing per-user write/rate
limiter.

## Three surfaces

Everything the writer asked for sorts onto three surfaces, distinguished by
how they execute and where the output lands.

### 1. Chat (the Session tab)

The Session tab has reserved space below its quick settings for exactly
this. An "Assistant for this story" toggle joins the quick settings when
there is something to toggle.

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
  - Reference in chat (drop it into the Session tab chat),
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

Iteration is capped (per-turn tool-call limit) so a loop on a slow endpoint
cannot run away.

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

## Schema touchpoints

- `users.llm_config`, `stories.llm_config`: already reserved; this fills
  them in (endpoint, encrypted key, model-per-role; per-story override is
  model + toggle).
- `lore_entries.activation_mode`: already reserved; context assembly
  activates it.
- `app_settings`: new rows for the egress policy and the host whitelist.
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

## Sequencing sketch

Not a contract, but the natural order, foundations first:

1. Gateway module, OpenAI-compatible adapter, egress policy + admin
   whitelist, account config UI + test connection, encryption. No surfaces
   yet.
2. Chat (rubber duck) on the Session tab, ephemeral, with reference-in-chat.
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
