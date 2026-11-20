# The Assistant (LLM integration)

Status: Phase 9, shipped (status reconciled 2026-07-29; the universe-wide
enrichment pass and character arcs followed on 2026-11-18, #845 and #846). The gateway
(`src/lib/server/llm/`), the account settings page, the chat tab, inline
co-author and continuation, the reviewer role, the admin egress panel, the
per-story mute, and the background jobs with their activity cards are all
merged. The "Frontend wiring map" at the end records where each surface
landed. The design intent below still holds and the shipped code matches
its shape; where the text speaks of the work in the future tense, read it
as the rationale that produced what is now built. Numbers and prompts
marked TODO remain placeholders to calibrate against a real prose corpus.

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
   the Assistant tab stays as the un-mute switch. The mute also keeps the
   story's prose out of universe-wide work started from elsewhere (the
   universe outline and tools, universe continuity, enrichment, character
   arcs), through one condition, `storyAssistantOn()` in `universe-scope.ts`
   (#975).

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

Codex ships no bundled model. The writer either picks a provider preset
(Claude, ChatGPT, Gemini, DeepSeek, OpenRouter; the preset prefills and owns
the endpoint URL) or configures a custom OpenAI-compatible endpoint: Ollama
on a local machine, a hosted API, a self-hosted vLLM. Two adapters sit behind
the gateway's Provider interface: the OpenAI-compatible one (custom endpoints
and every preset except Claude; Gemini and DeepSeek ride their compatibility
layers) and a native Anthropic adapter speaking the Messages API. The config
carries a provider discriminator (default 'custom' for configs that predate
it) and the gateway picks the adapter from it. Each adapter carries its own
side of the wire: the Anthropic one maps the per-role tuning onto adaptive
thinking and effort and marks the prompt cache (five minutes, or an hour when
the account's `cacheTtl` says so); the OpenAI-compatible one
sends the per-role temperature (near-greedy decoding for the review passes,
which quote the text they edit) and drops the thinking a local reasoning
model emits inline, in `<think>` tags or a separate `reasoning_content`
field, so the scratchpad never reaches the transcript.

The Claude provider can also run a web search itself, off unless the account
turns it on and then only on a universe flagged as an established published
setting: canon is the thing a search settles that the writer's own notes
cannot. The adapter attaches Anthropic's `web_search` server tool (the dated
2026 variant on the models that carry it, the original elsewhere, capped at
five searches a turn); the search runs on Anthropic's servers and the answer
returns as ordinary content, so Codex's tool loop never touches a raw web
result and the only outbound traffic from the server is still the request to
the configured endpoint. No other provider has an equivalent Codex can declare,
but an OpenAI-compatible endpoint with a search switch of its own reaches the
same place through `extraParams` below.

A Codex-side search tool is not a deferred item: it is ruled out. Holding a
search key, calling a search API, and feeding raw web text into a loop that
holds `suggest_edit` would give up all three properties above, and asking the
endpoint to search covers the use case without any of it.

Codex cannot keep up with how every OpenAI-compatible server spells its own
switches, so the config carries an escape hatch: an `extraParams` object,
account-wide and per role (the role's laid over the account's, key by key),
merged into the body the OpenAI-compatible adapter sends. The writer pastes
whatever their server documents - a flag that turns reasoning off where the
llama.cpp `chat_template_kwargs` spelling does not fit, sampler settings
Codex has no field for. It is stored config only, never client input at
request time, and the fields the adapter owns (model, messages, max_tokens,
tools, tool_choice, stream, stream_options) are refused on save and stripped
on read, so nothing stored can break the wire contract the response parser
depends on. Reply length is configurable the same way, as a per-role
`maxTokens` that overrides what the surface asks for.

Both adapters report why the model stopped. A reply cut off at the token cap
is unusable - its text stops mid-sentence and its tool-call arguments stop
mid-JSON, which can parse into a plausible but wrong edit - so the agent loop
never runs tool calls from one. It retries the round with double the room and
fails the round loudly if that is still not enough.

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
  (continuation, co-author, reviewer, utility, chat; utility covers the
  background work - summaries, entity extraction, recaps), a tool-call budget
  (the maximum tool calls the Assistant may make in one turn), the per-role
  tuning map (thinking, effort, temperature, reply length, extra request
  parameters), and the account-wide extra request parameters. The key is
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
- `universes.llm_config` holds `{ models }` only (#1266). Models resolve role
  by role, most specific first: story, then the story's universe, then the
  account (`scopeModels`, `layerModels`, `resolveLlmConfig(db, userId,
  scope)` where scope is a story id or `{ storyId?, universeId? }`). Work
  with no one story (universe chat, `/enrich`, the library's "Suggest
  details", character arcs, universe continuity) passes the universe. A
  role's tuning, the endpoint, the key, prices and context windows stay the
  account's. Both levels are set from an Assistant section on the universe's
  and the story's settings (`ScopeModels.svelte`), shown once the Assistant
  is set up; the mute stays per story.

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
  refuse private, loopback, link-local, and unique-local addresses
  (including IPv4 targets embedded in IPv6: mapped, NAT64, 6to4) and other
  reserved IPv6 ranges (Teredo, documentation, discard),
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
(`#lib/server/llm/`) that:

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
does not meter interactive spend, but an agentic tool loop on a slow endpoint
can still run away. The gateway enforces a per-turn tool-call budget and a
token ceiling, and the streaming endpoint is covered by the existing per-user
write/rate limiter.

Background review runs, which fan over many scenes unattended, do meter
themselves, and so does the standalone summaries job (it stops between
summaries; a rerun skips the ones already fresh). Two account settings sit in `users.llm_config`: `spendWarnUsd`
(the pre-flight confirm step turns into a warning above it, default 2) and
`spendCapUsd` (the run stops at the next scene boundary once it has spent
that much, staging nothing partial; a retry resumes through the existing
completed-scene skip). Both are priced from the account's prices: the
`modelPricing` snapshot the last model discovery wrote, with
`modelPricingManual` (what the writer typed, for the many endpoints that
report no prices, Claude among them) laid over it. Typed prices are dropped
when the provider or the endpoint host changes (another endpoint can serve the
same model id at another price), so the cap reports the model as unpriced
rather than metering at a stale figure; typed context windows are kept.
Claude's cache writes are
metered at their premium (1.25x, 2x for the one-hour cache) and cache reads at
a tenth. The tenth applies only to the Claude provider; cached tokens an
OpenAI-compatible endpoint reports are metered at the full price, since what
such an endpoint charges for them is not known. Those rates live in one place, `$lib/assistant-cost.ts`, shared by
the meter, the estimate, and the usage list on the account page; each
`assistant_usage` row stores its cache shares (null on rows from before
they were kept, which price at the plain rate). A cost figure is only ever shown or enforced when
the resolved model actually has a price there: with no price the pre-flight
estimate reports tokens alone, and a set cap is reported as not applied
rather than guessed at or skipped in silence. The estimate itself
(`llm/estimate.ts`) assembles the same frame and per-scene deltas the run
would send, counts them, and scales by an agentic multiplier drawn from this
account's own `assistant_usage` rows for the model where there are enough of
them, or a stated static 2.5 where there are not. With the Claude provider
it prices each scene's first request and the survey requests at the cache
write rate for the account's cache lifetime, and the resent rounds at the
plain price, so the figure errs high. The gateway records every
request into the run's meter (passed on the request) as it logs its usage
row, including an attempt that failed partway through a stream and was
retried or given up on: the endpoint bills the tokens it had used, which the
adapter attaches to the error. Claude reports the output count only at the
end of a stream, so for a stream that failed before then the adapter
estimates it from the characters streamed so far.

The tool-call budget is a writer-set value in `users.llm_config`, not a
fixed number Codex chooses. The point of bring-your-own-endpoint is that the
writer owns the trade-off: someone running a model on their own server
incurs only electricity and may want a generous budget, while someone on a
metered API may want a tight one. The setting has a sensible default and an
instance ceiling (today the fixed `MAX_TOOL_BUDGET` of 100; an admin setting in
`app_settings` is not built): a runaway loop still ties up a
server connection (and, for a background job, a worker slot) regardless of
who pays for the tokens, so a shared hosted operator can bound it
instance-wide. On self-host the operator is the writer, so the ceiling is
theirs to raise or remove.

The writer sets it as "Lookups per reply" on the Account Assistant page
(1 to 100, default 20; #990). It is stored under `toolCallLimit` only once the
writer sets it: the older `toolCallBudget` key was written on every save while
no screen could set it, so it only holds the old default of 8 and is ignored.
When a chat reply stops because the limit ran out or the context window
filled, the stream carries a `stopped` frame, the reason persists in the
message meta, and the panel shows a note under the reply.

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
- A composer (#1171): one bordered box with the text field and a row of
  controls under it. The slash button opens the command menu, every chat
  action in sections (Chat, Write, Review, Look up, Upkeep, Model) with a
  filter; typing "/" in the field opens the same list, and each entry is
  also a typed `/command` (`#lib/assistant-slash` is the one list). The
  model chip shows the model and effort the chat runs on and opens a picker
  (the endpoint's listed models plus any already set); the choice belongs to
  the chat (`assistant_chats.settings`, migration 0087) and rides with each
  message, laid over the chat role's model by `withRoleOverride`. Effort is
  only offered on Claude models that take it. The quoted passage from "Ask
  the Assistant about this" sits in the row as a chip with an x. The header
  is the chat's title, a clock button for the chat list, and a new chat
  button; muting moved into the command menu.
- Context chips (#1172): the + button (or `/context`) opens a picker that
  searches the writer's whole library (any universe; stories the Assistant
  is muted on are left out) for scenes, chapters, entities, notes and
  stories. A story offers its outline and summaries, the whole book (with
  its word count and, where the endpoint reports prices, what sending it
  costs), or one chapter or scene. Picks ride on the next user turn as
  `attachments` (kind, id, label; kept in the turn's meta), the server reads
  each by id and owner (`#lib/server/llm/attachments.ts`), cuts them to
  their own budget (40% of the window, no ceiling, small ones whole and the
  large ones to equal shares), and folds them into the newest turn after
  the transcript is fitted. Earlier turns only name their attachments, so a
  book is sent once, not with every later message. A cut attachment is
  marked shortened on the stored turn and its chip says so.

The chat is sync and streaming. It is the home of:

- the rubber-duck role (user-driven, no automatic context injection beyond
  what the writer references),
- "reference in chat" (pull the current selection into the conversation,
  and scenes, chapters, entities, notes or stories through the context
  picker, as context the writer then asks about),
- questions about the world: relationships, entities, "what happened to
  X", grounded in the universe data (see "Grounding"),
- tool-driven actions like "using the scene 'Session template' make one for
  tonight with X, Y, Z" (see "Tool use"),
- the usual chat affordances: regenerate a message, copy, stop generation.

Persistence: chats are stored per scope (story or universe) and user, any
number of them (`assistant_chats`, with turns in `assistant_chat_messages`;
issue #985, migration 0080). The panel opens the most recently used chat; a
clock button at the top lists the scope's chats newest first, searchable by
title, and the new chat button (or `/new`) starts a new one, which the server creates on its first
message and names after it (`x-chat-id` on the response tells the panel the
id). "Delete chat" removes one with its turns and summary. Titles are not
editable yet.

### 2. Inline (the editor)

Sync, in the prose, distinct from the lookup-based entity autocomplete that
already ships.

- Continuation: inline ghost-text from the model, Tab to accept, built as
  its own CodeMirror extension in a reserved compartment, kept separate from
  entity autocomplete (they share a UX pattern, not a backend).
- Co-author: a side-panel generation surface with insert / edit / reject,
  assembled from current-scene plus chapter-summary plus active-character
  context.
- Scene draft (#1168, step 1): the co-author role at the size of one whole
  scene. The writer asks for it (`/draft <brief>` in the Assistant chat with
  the scene open, or "Draft this scene..." on the scene's menu in the left
  sidebar), fills a short brief form (what happens, a length in words that
  defaults to the story's median scene, an optional point of view), sees the
  count (tokens in, tokens expected out, the price when the model has one)
  and confirms. It is writer-invoked only: nothing starts one on its own, it
  is not a tool the model can call, and it is not a suggested-prompt chip.
  There is no setting for it; the account switch and the per-story mute are
  its only gates. The draft is written by a background job into its own
  staged row (`assistant_drafts`) and shown in a card in the Assistant panel
  (`AssistantDraft.svelte`), where the writer edits it and chooses "Fill this
  scene" (only while the scene has no prose), "Add as a new scene after this
  one", or "Discard". There is no replace action. See "Writes are
  suggestions" and "Background jobs".
- Chapter draft (#1168, step 2): the same, over the scenes of one chapter.
  The Write page has no chapter focus of its own, so the command is a
  separate one, `/draft-chapter <brief>`, which drafts the chapter the open
  scene is in; "Draft this chapter..." on the chapter's menu names the
  chapter directly. The form (`AssistantChapterDraft.svelte`) takes a brief
  for the chapter, one length and point of view for every scene, and a
  ticked list of the chapter's scenes with a line each, prefilled from the
  scene's summary when it is usable. A chapter with no scenes is refused
  with a message saying to add them first: the run drafts into scenes that
  exist and never creates any. Scenes with text start unticked. A scene that
  already has an undecided draft cannot be ticked and is left out. One job
  drafts the ticked scenes in order; each result is an ordinary scene draft,
  kept or discarded on its own in that scene's card. The chapter card lists
  the drafts and their state and links to each scene.
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
- A scene draft is staged in `assistant_drafts` and never touches a scene
  until the writer chooses. "Fill this scene" is refused when the scene has
  any prose at that moment, checked under the scene's row lock in the same
  transaction as the write, and it goes through the normal save path
  (`saveSceneBody`), so it is a revision like any other save. Otherwise the
  draft can only become a new scene after the one it was written for, with
  status `draft`. A stopped or failed run leaves the scene as it was. A
  chapter draft stages one such row per scene and nothing else: a scene's
  text is staged only once it is whole, and each row is decided separately.
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

A run over many scenes of one story (the whole-story or chapter review) splits
the assembly in two rather than reassembling per scene: `assembleStoryFrame`
returns the scene-independent tiers (frame, outline, entities, notes, universe
backbone), assembled once and rendered into the system message, and
`assembleSceneDelta` returns the two tiers that move with the scene
(scene-local, lore), which ride at the front of the user message. The system
message is then byte-identical from scene to scene, so an endpoint's prompt
prefix cache holds across the run. Each part fits its own share of the budget
(the stable part takes the larger one).

A surface can also name the tiers it wants (`includeTiers` on all three
assembly entries): tiers left out are neither queried nor rendered. A review
pass whose categories do not include `lore` ships only the frame, the outline,
and the scene itself, since entities, lore, notes, and the universe backbone
only matter to the lore category; the sparing pass (no categories) keeps the
full stack. A review-thread reply has its own assembly
(`assembleReviewReplyContext`), since guests read the reply and write part of
the thread: the story frame without the world description, and the guest quick
cards (summary, aliases, first three details) of the entities mentioned in the
story's live scenes. No relationships and no full records. The passage under
discussion is already excerpted into its task message.

The world context budget, and the side panel's transcript budget, are shares
of the resolved model's context window (`context/budgets.ts`), each capped by a
ceiling chosen for cost, since every chat turn resends both. With no known
window they fall back to the old fixed defaults (6000 and 8000). Chat and
co-author scale; the review passes and review-thread replies keep the fixed
world budget, since the per-scene cost and the up-front estimate depend on it.

When the chat transcript outgrows its budget, the turns that fall out are not
just dropped: they are folded into a running summary on the utility role
(`chat-summary.ts`), stored per chat in `assistant_chat_summaries`, and
sent as a system message ahead of the newer turns. The summary is refreshed only
when more turns fall out of the budget, or when 30 turns have built up after it
(the browser sends its newest 40, so the anchor must not slide out of that
window), and each refresh leaves at most 20 turns and half the budget verbatim.
Because the browser sends a sliding window of turns with no ids, the summary
records a digest of the newest writer turn it covers, paired with the writer
turn before it, to find its place; writer turns are always stored, so the
anchor survives a reload. A failed refresh falls back to dropping turns and is
retried on the next message; deleting the chat deletes its summary. One
summarising step serves every provider rather than Claude's
server-side compaction, so the behaviour is the same everywhere.

TODO (needs a real corpus): the token budget per tier, the split between the
stable and per-scene shares, the truncation and prioritisation strategy when a
story outgrows the budget, and how far the neighbour window reaches. These are
calibration decisions, not design decisions, and guessing them now would be the
exact mistake the roadmap warns against.

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
  refreshing scene and chapter summaries in bulk, and drafting a whole scene
  (a long generation on a slow model, so it is a job and not a stream).

Derived artifacts that are expensive to compute (a character's arc summary,
"what happened to them across the stories they are in") are cached on the
entity with a fingerprint of the request they were written from (see
"Out of date by fingerprint" below), and regenerated by a job rather than on
every view.

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
  Built (#846): `characters.arc_summary_md` / `arc_summary_at`, written by the
  `assistant-enrich` job for one character, shown in the character editor.

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
`#lib/server/llm/`:

```
#lib/server/llm/
  gateway.ts        - the one public entry: complete(), stream(). Orchestrates
                      config -> context -> provider -> tool loop -> stream.
  config.ts         - read users.llm_config + stories.llm_config, merge
                      (the storyPreferences pattern), decrypt the key.
  egress.ts         - the SSRF guard: resolve host, validate against the admin
                      policy, connect to the validated address.
  providers/
    types.ts        - the adapter interface (chatStream, respond, listModels).
    openai.ts       - the OpenAI-compatible adapter (custom + most presets).
    anthropic.ts    - the native Anthropic adapter, same interface.
    presets.ts      - the provider presets (id, label, base URL, key hint).
    index.ts        - providerFor(id): the one id -> adapter switch.
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

- Chat: `POST /api/assistant/chat`, SSE, stored per chat (`chatId` in the
  body, `x-chat-id` back); `GET` and `DELETE /api/assistant/chats/[id]` load
  and delete one.
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
SSOT): `assistant-review-v2` (scene/chapter/story passes), `assistant-enrich`
(entity alias/detail/summary suggestions), `assistant-summaries-v2` (summary_md
maintenance). All three are created with pg-boss's `exclusive` policy, which is
what makes a `singletonKey` hold one queued or running job per key; review and
summaries moved off their original default-policy names (`assistant-review`,
`assistant-summaries`) for that, and the worker drains the old names for one
release (#1041). Expensive derived artifacts (a character's arc summary) cache on
the entity with a fingerprint of the request they were written from.

#### Out of date by fingerprint

Built (#1197). A character arc, an enrich read and a chapter summary the
Assistant wrote are each stored with `requestHash` of the exact messages sent
(`characters.arc_summary_input`, `assistant_enriched_input` on the three
entity tables, `chapters.summary_input`). Nothing marks them when the writer
saves. Whether one is out of date is worked out when it is read or when a pass
runs, by building the request as things stand with the same builder the job
uses (`arcRequest(s)`, `enrichRequest`, `chapterSummaryRequest`) and comparing
hashes:

- Arcs: the Plan page shows an arc as out of date (`planArc`). The context
  still carries an out-of-date arc, labelled as written before later changes
  and possibly out of date, so the scenes in context win where they differ
  (`arcLine` in `context/assemble.ts`, the one place that decides; a current
  arc is sent unlabelled). Nothing rewrites an arc without the writer asking,
  so leaving it out would drop a lead character's history after any edit.
  The exception: text of a story the Assistant is turned off for must never
  reach the model, and an out-of-date arc may retell one. The arc job stores
  the stories it read (`characters.arc_summary_stories`, plain ids), and an
  out-of-date arc is left out unless every one of them still exists, is out
  of the trash and is still read (`buildScopeEntities`). The list is on the arc, not derived
  from mentions, so it holds after the muted scene is deleted, the character
  is written out of it, or the story is deleted for good; no save writes
  anything for it. Arcs from before the column were given every story of
  their universe by migration 0093. Unmuting brings the arc back. Only the writer's Refresh arc writes one,
  and it always calls the model. Only the characters that make the entity
  cap are checked, and the check reads one row per scene.
- Chapter summaries: the context and an attached chapter leave an
  out-of-date Assistant-written one out (`chapterSummaryToSend`, used by
  `storySkeleton` and `attachments.ts`), and the summaries pass rewrites
  exactly those. One the writer wrote (no `summary_generated_at`) is never
  out of date.
- Enrich reads: the pass (`enrichUniverse`) builds every mentioned entity's
  request and sends only those whose hash differs from the stored one. The
  hash covers the entry's name and its passages, not what is recorded on it
  (aliases, details, whether a summary is asked for), so accepting what a
  read suggested does not buy another read of the same passages.

An arc and a chapter summary read scene summaries, and an Assistant-written
scene summary is itself only current while its scene has not changed
(`summary_generated_at` against `updated_at`). So both builders take a scene
summary only while it is usable (`usableSceneSummary` in
`summary-currency.ts`: the writer's own, or the Assistant's while current).
For an arc the passage around the first mention stands in; for a chapter the
scene is left out. An edit to a scene therefore puts what was written from
its summary out of date at once, without waiting for a summaries pass. The
pass rewrites scene summaries first and chapters from the result, so it
converges in one run, and a rewritten summary that comes out the same puts
the arc and chapter back to current. The other readers of scene summaries
(the outline's scene lines, neighbouring scenes, `list_scenes`, an attached
story outline, the review survey) still send a scene summary as it is stored.

So a save runs no Assistant bookkeeping and takes no Assistant lock, the same
request is never paid for twice, and a change that is undone reads as current
again. `arc_summary_at`, `assistant_enriched_at` and a chapter's
`summary_generated_at` are plain written-at times. A job stores the hash of
the request it sent, so a change that lands during the call leaves the result
out of date with no compare-and-set. A release that changes a prompt's wording changes every fingerprint of
that kind. Scene summaries keep their timestamp rule
(`summary_generated_at` against the scene's `updated_at`): they read only
their own row.

Rows from an earlier release. An arc's fingerprint is unchanged since
3.21.3, so one that was current still is; an arc without one reads as out of
date until the writer refreshes it. A chapter summary had no fingerprint
before 0092: migration 0094 gives one the release counted as current a
stand-in (`at-upgrade:` and a digest of its title and scene summaries, which
`chapterInputAtUpgrade` works out the same way), so it reads as current until
something it reads changes and the next pass swaps in the real fingerprint
without a call; one the release counted as out of date, or with a scene whose
own summary was out of date, is rewritten once. An enrich read stored by
3.21.3 or 3.21.4 carries a fingerprint that covered aliases and details
(`enrichInputAsOf3_21`): a pass that finds it matching keeps the read under
today's fingerprint without a call. An enrich read without a fingerprint is
adopted without a call when no scene mentioning the entity changed since it
was written, and sent otherwise. The fifty-years-back times older releases wrote as marks mean
nothing once a fingerprint is stored.

A review job writes its progress to `assistant_review_runs` (one row per
pg-boss job id, a jsonb state: phase, scenes completed, current scene, counts,
and the failure list). The job-status endpoint reads it while the job runs, so
the review window can show where the pass is; a retry of the same job after a
worker restart reads it too and skips the scenes already handled. The state
also records the scope the run was over (the same key the queue holds one
unfinished job per: the mode, the target and, for a copyedit, the categories
it checks), so a run that stopped at the spend cap is picked up by the
next run over that scope even though it arrives with a new job id; only the
newest run over the scope is looked at, it is adopted only if it was capped
(or was itself a continuation of a capped run that threw or was cancelled
before it finished), and it starts again with the whole ceiling, minus the
scenes whose pass failed and those edited since their pass read them, which
are reviewed again. A failure to read or adopt the earlier run fails the
attempt for pg-boss to retry rather than starting over. A copyedit capped before the
categories joined the key is continued only when its job (still on the legacy
queue) shows it checked the same categories; otherwise it starts over. The rows are
disposable, and a daily worker sweep drops those older than 30 days. The
review enqueue holds one unfinished job per scope (and the summaries enqueue one
per story), so a duplicate request cannot start a second pass over the same
scenes and is answered with a 409, and the Assistant
queues send with an expiry of hours rather than the pg-boss default of 15
minutes, which would hand a long run to a second worker while the first is
still going. A heartbeat (60 seconds) catches a worker that died, so its job
is retried in minutes rather than after the expiry, and pg-boss's job signal
is passed into the run so an expired or stopped job also stops calling the
model. A run that pg-boss is going to retry (its signal aborted with retries
left, or its job moved to a retry or picked up again under a newer start time)
sends no notification, so the writer hears once, from the run that finishes. The worker runs up to four Assistant jobs at once but one per writer
(the job's pg-boss group), and every model request has a ten-minute idle
timeout in the egress layer, so one writer's hung endpoint stalls only that
writer's queue. A running job's activity card has a Stop button, which
cancels the writer's own job (freeing its key at once); the worker aborts the
run at its next heartbeat. The top bar's Background jobs list
(`BackgroundJobs.svelte`, always in the author bar) lists
the same jobs with their start time, Open and Stop, so a job whose card was
dismissed can still be found and stopped. Each job's spend is kept per pg-boss job id in
`assistant_job_spend` while a cap is set, so a retry of the same job carries
on against the ceiling instead of starting at zero. Before it reviews
anything, a story-level pass refreshes scene summaries that are missing or
stale (the `assistant-summaries` logic, called directly), since both the
context assembly and the cross-scene pass read them.

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
- Cached character arc summaries: `characters.arc_summary_md` and
  `arc_summary_at` (migration 0079), with the fingerprint of their request in
  `arc_summary_input` (migration 0082) and the stories it read in
  `arc_summary_stories` (migration 0093). `chapters.summary_input` holds the
  fingerprint for chapter summaries (migration 0092).
- Scene drafts: `assistant_drafts` (migration 0096), one row per draft asked
  for, with at most one undecided draft (pending, running or ready) per
  writer and scene. It cascades with its user, story and scene. A chapter
  draft's rows carry `chapter_id` and `position` and share a `job_id`; there
  is no table for the run itself. Deleting the chapter sets `chapter_id` to
  null and keeps the rows (the scenes stay in the story, so their drafts
  do); `position` is what marks a row as one of a run. The row is written
  with its `job_id`, which the queue is then given as the job's id, so a row
  whose job was never queued is told from one still waiting. Indexed by
  story, job and chapter.
- Persisted chats: `assistant_chats`, with `chat_id` on
  `assistant_chat_messages` and `assistant_chat_summaries` (migration 0080,
  which made each earlier conversation its scope's first chat).

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
8. Deferred refinements: chat persistence and browsing. (The native Claude
   adapter and provider presets have since shipped; see "Configuration".)

## Frontend wiring map

Written as the hand-off for the frontend work; it now records where each
surface landed. Status markers: [built] the helper or surface exists and is
tested; [to build] not built yet (only the deferred items below).

Everything that touches the key or the endpoint is server-only. The browser
never calls the model endpoint; a SvelteKit `+server.ts` (SSE) or a form action
calls the gateway, which proxies through the egress guard.

### Gating (render nothing when off)

- [built] `accountLlmView(db, userId)` and `resolveLlmConfig(db, userId, storyId?)`
  (`llm/config.ts`). The gate is `assistantGate(...)` -> `{ configured,
  accountEnabled, tabEnabled, surfacesEnabled }`.
- [built] Feed the gate into the layout load (the way asset-backed features
  hide when no bucket is set), so the Assistant tab, editor menu items, and
  continuation render only when allowed. Rule: tab needs `tabEnabled`; in-editor
  and in-menu surfaces need `surfacesEnabled`; nothing renders when not
  `configured` or the master is off.

### Account Assistant settings (configure + enable)

- [built] Read: `accountLlmView` (never exposes the key; has `hasKey`,
  `assistantName`, `persona`, `models`, `toolCallBudget` (stored as
  `toolCallLimit`), `toolProfile`,
  capability flags, `cacheTtl`, the prices (`modelPricing`, the discovery
  snapshot, and `modelPricingManual`, what the writer entered, which wins;
  `effectivePricing` merges them), and the context windows: `modelContext` (the
  discovery snapshot) and `modelContextManual` (what the writer entered, which
  wins). `modelContextWindow(config, role)` resolves the window for a role's
  model, or undefined when unknown.
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
- [built] An admin panel section (policy select + host allowlist). No help
  article needed (admin panel).

### Per-story override (the Assistant tab's mute)

- [built] `saveStoryLlmOverride(db, storyId, { enabled?: false | null, models? })`
  - `enabled: false` mutes this story, `null` clears the override (back to the
  account default). A story can only subtract.
- [built] The mute control on the Assistant tab.
- [built] Model pickers per story and per universe (#1266):
  `saveUniverseModels`, the `saveAssistantModels` action on both settings
  pages, and `GET /api/assistant/models?universeId=` for the list.

### Chat (the Assistant tab) - sequencing step 2

- [built] `POST /api/assistant/chat` as an SSE `+server.ts`. It should:
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

- [built] `POST /api/assistant/continuation` and `/api/assistant/coauthor`
  SSE endpoints. Continuation: `stream(..., role: 'continuation', enableTools:
  false)`, no context needed beyond the current text the client sends. Co-author:
  build context with `assembleContext` first, `role: 'coauthor'`.
- [built] The CodeMirror ghost-text extension (its own compartment, distinct
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
- [built] Entry points (left-sidebar "Review this scene/chapter", story
  settings "Review this story", palette command). Whole-story review is a
  background worker job (see below).
- [built] The cross-scene continuity pass (the tail of a full review, and the
  standalone story and universe continuity jobs) runs in two stages instead of
  one whole-story turn. Stage A (survey) sends the scene summaries in story
  order, with a body excerpt where a scene has no summary yet, on a lean context
  (the frame and the entities), offers no tools, and asks for candidate
  contradictions as a JSON array of `{ sceneIds, claim }`. The adapters have no
  structured-output mode, so the reply is parsed leniently (the first JSON array
  in it, fence or prose around it tolerated) with one corrective retry before
  the pass fails. A listing that outgrows its budget (half the reviewer model's
  context window, the provisional 6000 tokens where the window is unknown) is
  split into sequential chunks, each surveyed on its own. Stage B (confirm)
  takes each candidate in turn, up to a cap of 24, with the full text of the
  scenes it names fetched server-side (bodies capped to fit) and only
  `leave_comment` and `suggest_edit` offered; a note is staged only if the
  contradiction is real, and a scene id the survey invented is dropped. This
  replaces the single pass that put the whole story in one context and read
  every scene through `get_scene`, which overflowed a small window silently and
  ran into the gateway's 200-call ceiling on a long story. A pass that finds
  nothing now stages nothing (the old design had the model leave an "everything
  holds together" comment on the first scene); the job's notification already
  reports that it found no continuity issues.

- [built] One theme per note (#1131): the review prompt asks for one comment
  per theme, so a recurring pattern, a pacing observation, and an overall
  impression arrive as separate notes the writer can resolve on their own. A
  pattern note opens with "Pattern note (<the pattern>):".
- [built] Pattern notes and the guided pass (#1132): `leave_pattern_note`
  stages a whole-scene note and the edits that fix each instance in one call,
  linked through `review_suggestions.pattern_thread_id` (nullable, set null
  when the note is deleted). Edits that do not locate are reported back; a
  retry with the same comment adds to the open note. It is left out of the
  minimal tool profile, and the prompt only mentions it when it is offered.
  "Work through this" on the note walks its pending edits in reading order
  (client state in `ReviewWorkspace`, `PatternPass.svelte`): Accept, Edit (an
  owner override on accept, recorded as the applied replacement), Skip, Stop.
  After an accept, `/api/assistant/pattern-reread` sends the changed paragraph
  and one either side with the note, offers only `suggest_edit` held to that
  window (`ToolScope.editWindow`) and linked to the note
  (`ToolScope.patternThreadId`) and to the accepted edit
  (`ToolScope.followsSuggestionId`, stored as
  `review_suggestions.follows_suggestion_id`, set null when that edit is
  deleted). A follow-up joins the back of the queue, after the note's own
  edits, oldest first (#1296), so the pass only moves forward. The pass shows every edit of
  the note as one list (#1297): the current one full with its buttons, the rest
  faded with their outcome, and a follow-up links back to its original. The
  re-read's status shows as a corner activity card (#1295).
- [built] Reasons on suggested edits (#1304): `suggest_edit` and each
  `leave_pattern_note` edit take an optional one-sentence `reason`, stored on
  `review_suggestions.reason` (nullable, whitespace collapsed, cut at 300
  characters) and shown as "Why:" under the change on the suggestion card and
  the guided pass. The review, chapter pattern and re-read prompts ask for it.
- [built] Chapter pattern pass (#1136), opt-in from the review modal
  (`patterns: 'chapter'` on the review job; part of the run's scope key). Runs
  before the scene loop (`pattern-pass.ts`): stage A surveys each chapter with
  two or more scenes (story frame only, the prose in chunks of the survey
  budget, one corrective retry) for up to 5 recurring habits as JSON; stage B
  creates one whole-scene note per pattern on its first scene and, per scene
  it names, one request offering only `suggest_edit` linked to the note
  (`ToolScope.patternThreadId`). Survey results, note ids, and applied scenes
  live in `ReviewRunState.patterns`, so a resumed run neither re-surveys nor
  repeats a scene. Open pattern notes are handed to the survey (not reported
  again) and to each scene review as prior notes. The estimate prices the
  survey only; the apply stage is listed as unknown.
- [built] Whole-book pattern pass (#1137): `patterns: 'book'` on a
  whole-story review (a chapter review asking for it runs the chapter pass,
  `runPatternScope`). `planBookPass` lists the book in reading order under
  chapter headings and checks the survey against 80% of the reviewer's known
  window (`wholeBookFit`): it fits and goes in one request (up to 8
  patterns), or it goes chapter by chapter, each survey handed the patterns
  found so far (name and description) and merged by name. An unknown window
  is not offered in the modal (`{ wholeBook: true }` on the review-job
  endpoint answers the check without contacting the endpoint). Notes name
  the chapters. A survey retry relies on the Anthropic adapter's existing
  cache of the last user block, so no adapter change was needed.

### Background jobs - sequencing steps 4 and 7

- [built] pg-boss queues `assistant-review-v2`, `assistant-summaries-v2`, and
  `assistant-enrich`, all `exclusive` (names in
  `queues.ts`, enqueue helpers in `jobs.ts`, handlers in `src/worker/handlers.ts`,
  registered by `src/worker/index.ts`). The handlers call the gateway directly
  (`complete`/`stream`, no HTTP hop) and write through the same review/entity
  helpers. Entity enrichment for one entity, from a story (story Plan) or
  across its universe (universe Plan), is queued by `/api/assistant/enrich`
  as an `assistant-enrich` job that carries `read` (handler `entityDetails`,
  job kind `details` in the activity center), because a slow model can take
  minutes. Since #1170 the button reads full text
  (`enrichEntityFromText`, `enrich-context.ts`): every scene that mentions
  the entity with the scene before and after each in its own story, or, as a
  separate choice from a story, the whole book when it fits one request.
  The text goes first and the entity and instructions last. Text over the
  utility model's budget (four fifths of the window less the reply; 6000
  tokens when the window is unknown) is read in parts in reading order, each
  told what the earlier parts found. Each part's finds are staged as it is
  read, so a later part failing or the job being stopped keeps them. There
  is no ceiling on parts: the count shown first, the spend cap (checked
  between parts, keyed by the job) and Stop bound it. A read that fails
  before finding anything is retried; one that found something is not, and
  its notice says what it left. The same
  endpoint with `estimate: true` counts the read without sending it, and
  the editor asks before a read over 8000 tokens. The `assistant-enrich` job
  still sends snippets (`enrichEntity`, at most 16), over
  every mentioned entity in a universe whose request differs from the one its
  last read sent (`/enrich`; see "Out of date by fingerprint"), and a job
  naming a character rewrites that character's arc (`arc_summary_md`)
  instead. Each is stored with a hash of the request it was written from
  (`assistant_enriched_input`, `arc_summary_input`), and no save marks
  anything (#1197). A current arc is still rewritten when the writer asks.
- [built] Scene drafts (#1168, step 1): queue `assistant-draft`, exclusive,
  one unfinished job per scene (`queueAssistantDraft`, handler `sceneDraft`,
  job kind `draft` in the activity center and the Background jobs list).
  `/api/assistant/draft` answers the form's defaults, the estimate
  (`estimate: true`, nothing queued) and the request itself, which stages an
  `assistant_drafts` row and queues the job; an estimate over the spend cap
  is refused there. The job (`runSceneDraft`, `llm/scene-draft.ts`) checks
  the account switch and the story's mute again, then makes one `coauthor`
  request: `assembleContext` with `precedingProse` for the world, the
  preceding prose and the open scene, and `buildSceneDraftMessage`
  (`prompts/scene-draft.ts`) for the brief, the length, the point of view,
  how the next scene opens (prose the scene already holds is in the context
  once, and the message only says to carry on from it). The reply limit
  asked for comes from the length (`draftMaxTokens`: words times 1.4 plus
  headroom, held to half the context window), but the limit sent is the
  gateway's (`requestReplyLimit`, the one function the gateway and the
  estimate both call). A role that may think (always on the Claude provider,
  elsewhere with Thinking on or an effort set) gets the writer's "Longest
  reply" for Write when one is set, and otherwise the thinking default,
  because thinking is billed as reply tokens and counts toward the limit. A
  role that does not think gets what the draft needs, and a "Longest reply"
  can only lower that, never raise it (`boundedReply` on the request). The
  estimate counts the reply at the limit sent for every role, times the
  number of scenes, and always labels it "up to"; the cap refusal uses that
  figure, so the figure held against the cap is never lower than what the
  request can spend. `mayThink` on the estimate only changes the wording of
  the note. When the limit sent is shorter than the draft needs, the
  estimate says where the scene would stop and why
  (`limitedBy`: the writer's setting, or the model's window). It also
  reports `capEnforceable` (false with no price) and `warnUsd`, and prices
  the prompt at the cache write rate on the Claude provider. The spend meter is
  keyed by the job. A reply cut off at the limit is kept as a ready draft
  with a note; a stop discards the draft; a failure marks it failed with the
  reason, to try again from the card. A reply with no text in it is settled
  at once as failed, with a note saying what to do (raise "Longest reply"
  for Write when the limit was all spent), and is not asked for again: it is
  paid for and would come back the same. A Stop that a read of the draft
  settled before the worker saw it (`settleOrphan`, whose minute of grace is
  measured in SQL against `created_at`) is still reported as stopped.
  `/api/assistant/draft/[id]` takes the
  writer's choice (fill, add, discard) for a draft they own, and a PATCH
  saves their edits to a ready draft's text (the draft row only). The PATCH
  and the two keeping choices carry `base`, the md5 of the text the window
  last saw (`textVersion`); when the stored text differs they are refused
  with 409 ("This draft was changed in another window.") and the card offers
  to load the current text. A blank PATCH is refused; Discard is how a
  draft is dropped. Asking and
  counting are gated on the Assistant being on for the account and story;
  reading a staged draft back, editing it and deciding it need only its
  owner, so a draft written before a mute or a switch-off is not stranded.
  The story page keeps the Assistant tab while such drafts wait
  (`hasWaitingDrafts`, which counts only drafts whose scene is live and in
  the story), showing only the draft cards and a line saying the Assistant
  is off for the account; nothing there can ask for a new draft, and the tab
  goes when the last draft is decided. Links from notices and lists open the
  card without the form (`draft=show`); the scene menu's link opens the form
  (`draft=1`). In the panel a start is ignored for 700 ms after the estimate
  appears and on a double click or key repeat (`confirm-guard.ts`), unsaved
  edits live in module state by draft id and are flushed when the page is
  hidden (`draft-edits.ts`), and an open brief form is kept in
  `sessionStorage` until it is started, cancelled, or the writer signs out
  (`draft-forms.ts`).
- [built] Chapter drafts (#1168, step 2): the same queue and table. The
  request (`/api/assistant/draft/chapter`: defaults, `estimate: true`, or
  the request itself) stages one `assistant_drafts` row per chosen scene with
  `chapter_id` and `position` and queues one job that carries the row ids in
  order and the chapter brief (`queueAssistantChapterDraft`, one unfinished
  job per chapter). The estimate is the sum of the scenes' requests, each
  later one counted with the scene before it, and over the cap it is
  refused. The job (`runChapterDraft`) makes one `coauthor` request per
  scene. Each is told the chapter brief, the closing part of the scene
  drafted just before it (it is not in the manuscript, so the context does
  not hold it), and the writer's line for the next scene where the single
  draft would use that scene's summary. The earlier draft is carried only
  when it is the run's previous row, still undecided, and its scene is the
  live scene directly before this one; a draft already kept is in the
  manuscript, and a scene further back is not what this one follows. The
  estimate counts it the same way, at the earlier scene's limit. A scene
  that comes back with no text ends the run there, as failed with its note,
  keeping the drafts before it. Before every scene it checks the
  writer's Stop, that the Assistant is still on for the account and the
  story, and the spend cap (one meter for the job); any of them ends the run
  there, keeps the drafts already written and discards the rows not reached.
  A Stop during a request drops that scene whole. A scene deleted or moved to
  the trash by its turn is left out and the run goes on. A request that
  fails is retried with the job, and the retry carries on from that scene;
  when no retry follows, that scene's row is marked failed and the rest are
  discarded. A row the writer discards mid-run is passed over, and does not
  stop the job. The job-status poll reports scenes settled out of scenes
  asked for (`chapterDraftProgress`), which the activity card and the
  Background jobs list show, and the notice says how many scenes were
  drafted and why the run ended when it ended early.

### Tool use and structural actions - sequencing step 6

- [built] Read tools (`get_scene`, `get_entity`, `find_appearances`,
  `search_text`) and prose write tools (`suggest_edit`, `leave_comment`) in
  `llm/tools/`. The gateway loop dispatches them, capped by the account
  tool-call limit (Lookups per reply). The run concludes once the model asks for a
  call past the limit, so using exactly the limit and then answering is not
  flagged as cut short. The frontend only renders the staged results (the
  `isAssistant` suggestions/comments).
- [built] The account `toolProfile` shapes the default set: `minimal` offers only
  `get_scene`, `suggest_edit`, and `leave_comment` and halves the budget, for
  endpoints running a smaller local model. A surface that names its own tools
  (the scoped review-reply turn) is unaffected.
- [built] The review-reply turn posts where guest reviewers can read it and
  carries their comments, so its reads are held to the thread's own story:
  `list_scenes` and `get_scene` under `toolScope.storyOnly` (live scenes of that
  story only), and no `get_entity`, `find_appearances`, or `search_text`.
- [built] `get_scene` sizes its result against the role model's context window
  when one is known (about a quarter of it, floor 8000 characters, the 200K
  ceiling unchanged). Sizing the assembled world context against the window is
  still to build.
- [to build] Structural write tools (create scene from a template, create an
  entity, set a quick detail, split a scene) need a preview-and-confirm artifact
  that does not exist yet; they are deliberately deferred. Add them as new tools
  in `llm/tools/registry.ts` + `dispatch.ts` with a staging store when taken on.

### Help and exports

- [built] Writer-facing help (configuring an endpoint, the kill switch and what
  it sends, the three surfaces, accepting suggestions), spread across the
  existing articles in `src/lib/docs/` (`account.md`, `editor.md`,
  `planning.md`, `reviewing.md`) rather than one Assistant article. The admin egress panel needs none.
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
- `context/assemble.ts`: `assembleContext`, `assembleStoryFrame`,
  `assembleSceneDelta`, `buildSystemMessage`.
- `gateway.ts`: `stream`, `complete`, `completeDetailed` (the only entries the
  surfaces call; `completeDetailed` also reports how many review notes the run
  staged), `GatewayRequest`, `AssistantDisabledError`.
- `review.ts` (existing): `listSuggestions`, `listThreads`, `decideSuggestion`,
  `setThreadResolved` - now Assistant-aware (`isAssistant`).
