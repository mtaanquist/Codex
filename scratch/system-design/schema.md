# Codex — data model

A self-hosted, web-based writing tool. Markdown is the authoring syntax; content is stored in Postgres. This document captures the current data model decisions.

LLM integration is explicitly deferred to post-v1 (see `design.md`). The schema keeps a few forward-looking columns — `users.llm_config`, `stories.llm_config`, `lore_entries.activation_mode` — so the feature can be bolted on later without a migration of live data. Those columns are called out inline below.

## Hierarchy

```
universe
  ├── story (one or more)
  │     ├── chapter (organisational)
  │     │     └── scene (atomic writing unit)
  │     └── outline nodes
  └── characters, places, lore entries
        (universe-scoped; surfaced per story by reference)
```

- **Universe**: owns shared worldbuilding. Every story belongs to one, even standalones (implicitly created on first story).
- **Story**: a novel, novella, short story, serial, etc. Form-agnostic.
- **Chapter**: an organisational container with a title and optional summary. Holds scenes.
- **Scene**: the atomic unit of writing. Owns the prose. Can be orphaned (no chapter) during drafting.

## Stack

- **Database**: Postgres
- **Content format**: Markdown in `text` columns (rendered on display/export)
- **Search**: `tsvector` for full-text, `pg_trgm` for fuzzy name matching
- **Case-insensitive handles**: `citext` for the public profile handle (requires the `citext` extension)
- **Squishy fields**: `jsonb` with GIN indexes where queried

---

## Core tables

### Users and access

```sql
users (
  id                  uuid primary key,
  email               text unique not null,
  display_name        text not null,
  handle              citext unique,        -- public profile slug ('@handle'); null until a public profile is claimed
  bio_md              text,                 -- short bio shown on the public profile shelf
  profile_public      boolean not null default false,  -- whether the '@handle' shelf is listed publicly
  public_archive_enabled boolean not null default false,  -- admin grants this before a user may publish public pages
  password_hash       text not null,
  role                text not null,        -- 'admin' | 'user'
  llm_config          jsonb not null default '{}',  -- reserved for future LLM integration; inert in v1
  preferences         jsonb not null default '{}',  -- theme, content width, autocomplete mode, entity underline toggle, etc.
  plan_id             uuid references plans(id),    -- null falls back to the default plan; see Plans and entitlements
  storage_used_bytes  bigint not null default 0,    -- reserved for quota enforcement; not maintained in v1
  created_at          timestamptz not null,
  email_verified_at   timestamptz,          -- null until the email-confirm link is clicked
  approved_at         timestamptz,          -- null until admin approves
  last_login_at       timestamptz           -- updated on successful sign-in; useful for stale-account cleanup
)
```

Sign-in succeeds only when **both** `email_verified_at` and `approved_at` are non-null. The two gates exist for different reasons: email verification confirms the address is real and reachable; approval is the operator's call about who gets to use the instance. Either may be skipped in a self-hosted single-user setup by setting both columns on the admin row at seed time.

**Plans and entitlements.** What a user is allowed to do (quotas, access to a public archive, and so on) is expressed through a plan and its entitlements, modelled below. Every user is on a plan, and the default plan grants everything, which is the right setting for self-host. What is deliberately not here yet is billing: there is no payment processing and no subscription state. Assigning a plan is an admin action for now, and a future subscription layer can set `plan_id` without disturbing anything else. The `storage_used_bytes` counter exists for eventual quota enforcement but is not maintained in v1.

### Sessions and credentials

Authentication is session-cookie based, with the session row stored server-side so it can be listed and revoked. Email verification and password reset use single-use tokens, stored only as hashes. Two extra factors are modelled from the start: time-based one-time passwords (TOTP) and passkeys (WebAuthn).

```sql
sessions (
  id            uuid primary key,        -- opaque id; the cookie carries this (or a hash of it)
  user_id       uuid references users(id) not null,
  created_at    timestamptz not null,
  last_seen_at  timestamptz not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,             -- set on sign-out or 'log out everywhere'
  user_agent    text,
  ip            inet
)

auth_tokens (
  id            uuid primary key,
  user_id       uuid references users(id) not null,
  kind          text not null,           -- 'email_verify' | 'password_reset'
  token_hash    text not null,           -- the raw token is emailed; only its hash is stored
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  created_at    timestamptz not null
)

user_totp (
  user_id       uuid primary key references users(id),
  secret        text not null,           -- encrypted at rest
  confirmed_at  timestamptz,             -- null until the first code is verified
  created_at    timestamptz not null
)

webauthn_credentials (
  id            uuid primary key,
  user_id       uuid references users(id) not null,
  credential_id text unique not null,    -- base64url of the raw credential id
  public_key    text not null,
  sign_count    bigint not null default 0,
  transports    text[],
  name          text,                    -- user label, e.g. 'phone' or 'security key'
  created_at    timestamptz not null,
  last_used_at  timestamptz
)
```

### Plans and entitlements

A plan is a named bundle of entitlements. Entitlements are key/value rows, so a new limit or capability can be added without a schema change. Self-host seeds a single default plan that grants everything; the hosted service can define more.

```sql
plans (
  id            uuid primary key,
  key           text unique not null,    -- 'default', 'free', 'supporter', ...
  name          text not null,
  description   text,
  is_default    boolean not null default false,  -- assigned to new users when none is set
  sort_order    int not null default 0,
  created_at    timestamptz not null
)

entitlements (
  id            uuid primary key,
  plan_id       uuid references plans(id) not null,
  key           text not null,           -- 'max_universes', 'max_stories', 'storage_bytes', 'public_archive', ...
  value         jsonb not null,          -- a number, a boolean, or null for unlimited
  created_at    timestamptz not null,
  unique (plan_id, key)
)
```

Enforcement (rejecting a save or a create that exceeds an entitlement) is deferred; the model exists now so it does not require migrating live data later.

### Universe and story

```sql
universes (
  id              uuid primary key,
  owner_id        uuid references users(id) not null,
  name            text not null,
  description_md  text,
  created_at      timestamptz not null,
  updated_at      timestamptz not null
)

stories (
  id                  uuid primary key,
  universe_id         uuid references universes(id) not null,
  owner_id            uuid references users(id) not null,
  title               text not null,
  author              text,
  brief               text,
  description_md      text,
  position_in_series  int,              -- null if standalone or unordered
  visibility          text not null default 'private',  -- 'private' | 'unlisted' | 'public'
  is_adult            boolean not null default false,   -- author-flagged adult content; readers avoid it by default
  cover_asset_id      uuid references assets(id),       -- null renders a default cover from title and author
  llm_config          jsonb not null default '{}',  -- reserved for future LLM integration; inert in v1
  created_at          timestamptz not null,
  updated_at          timestamptz not null
)
```

`llm_config` on both `users` and `stories` is **reserved for future LLM integration.** When that feature eventually ships, the per-user column will hold endpoint URL, key, and model-per-role mappings (continuation, co-author, editor, rubber duck); the per-story column will hold overrides merged at request time. In v1 both columns exist but are always `{}`; they live on the tables now so the eventual feature doesn't require migrating live data.

### Chapters and scenes

```sql
chapters (
  id            uuid primary key,
  story_id      uuid references stories(id) not null,
  position      int not null,
  title         text,
  summary_md    text,
  metadata      jsonb not null default '{}',
  updated_at    timestamptz not null
)

scenes (
  id                    uuid primary key,
  story_id              uuid references stories(id) not null,
  chapter_id            uuid references chapters(id),   -- nullable: orphan scenes allowed
  position_in_chapter   int,                             -- null when orphan
  global_position       int not null,                    -- order across all scenes in story; drives continuous scroll view
  title                 text,
  body_md               text not null default '',
  pov_character_id      uuid references characters(id),
  location_id           uuid references places(id),
  story_time            text,                            -- freeform: "Day 3 afternoon"
  characters_present    uuid[],                          -- references characters.id, GIN indexed
  status                text not null,                   -- 'outline' | 'draft' | 'revised' | 'final'
  summary_md            text,                            -- one-line what happens; shown in sidebar and outline
  word_count            int not null default 0,          -- updated on save
  metadata              jsonb not null default '{}',
  updated_at            timestamptz not null
)
```

Key points:

- `body_md` lives on scenes, not chapters. Chapters are organisational only.
- `chapter_id` is nullable to support drafting scenes before they have a chapter home.
- `global_position` enables chronological views, continuous-scroll (Scrivenings-style) rendering, and reordering across chapter boundaries.
- `characters_present` is a UUID array rather than a join table. Cheap, GIN-indexed, easy to query.

---

## Worldbuilding entities

Characters, places, and lore entries belong to the universe, not to a story. Identity lives in exactly one place. A story does not own its own copies; it surfaces the universe entities relevant to it, which is answered by declared membership and by mentions (see below). Per-story differences are layered on through the overlay notes, not by forking the entity. Because every entity is universe-level, a relationship can link any two of them, and a story view simply filters which entities and relationships it shows.

### Characters and places (first-class)

Characters and places are first-class tables with their own distinct fields. They are not foldable into the user-defined entity category system, because characters have aliases (used for mention detection and POV assignment) and places have location references, neither of which fits the generic lore shape.

```sql
characters (
  id                      uuid primary key,
  universe_id             uuid references universes(id) not null,
  owner_id                uuid references users(id) not null,
  name                    text not null,
  aliases                 text[] not null default '{}',  -- nicknames, variants; used for mention detection
  summary_md              text,                          -- one or two lines; shown in hover popovers
  body_md                 text not null default '',
  auto_detect_mentions    boolean not null default true, -- set false for common-word names ("Will", "Art")
  metadata                jsonb not null default '{}',
  imported_from           jsonb,                         -- original card data if imported (SillyTavern etc)
  created_at              timestamptz not null,
  updated_at              timestamptz not null
)

places (
  id                      uuid primary key,
  universe_id             uuid references universes(id) not null,
  owner_id                uuid references users(id) not null,
  name                    text not null,
  summary_md              text,
  body_md                 text not null default '',
  auto_detect_mentions    boolean not null default true,
  metadata                jsonb not null default '{}',
  created_at              timestamptz not null,
  updated_at              timestamptz not null
)
```

### User-defined entity categories

Everything that isn't a character or place is a lore entry, but the category it belongs to is user-defined. New universes are seeded with a single "Lore" category; users can rename it, delete it, and add as many more as they need ("Magical spells", "Technologies", "Factions", "Ships", etc).

```sql
entity_categories (
  id            uuid primary key,
  universe_id   uuid references universes(id) not null,
  owner_id      uuid references users(id) not null,
  name          text not null,        -- "Lore", "Magical spells", "Technologies" etc
  color         text,                 -- hex or token; used for sidebar dots and mention underlines
  sort_order    int not null,
  created_at    timestamptz not null
)

lore_entries (
  id                      uuid primary key,
  universe_id             uuid references universes(id) not null,
  owner_id                uuid references users(id) not null,
  category_id             uuid references entity_categories(id) not null,
  title                   text not null,
  summary_md              text,
  body_md                 text not null default '',
  keywords                text[] not null default '{}',  -- in-editor search, mention detection, and (eventually) LLM context injection
  activation_mode         text not null default 'keyword',  -- 'always' | 'keyword' | 'manual'
  auto_detect_mentions    boolean not null default true,
  metadata                jsonb not null default '{}',
  created_at              timestamptz not null,
  updated_at              timestamptz not null
)
```

`keywords` earns its keep in v1: it powers in-editor search/filtering of lore and feeds the mention-detection pass on save. `activation_mode` is **reserved for future LLM context-injection behaviour** — mirroring SillyTavern's lorebook semantics, `keyword` entries would be injected into LLM context only when a keyword appears in the current scene; `always` entries would always be injected; `manual` entries would never be injected automatically. It has no function in v1. Defaulting to `keyword` means existing rows will behave reasonably if and when the feature is added.

### Per-story context for universe entities

Characters, places, and lore entries evolve between stories. The core record is canonical; per-story notes layer on top.

```sql
character_story_notes (
  id              uuid primary key,
  character_id    uuid references characters(id) not null,
  story_id        uuid references stories(id) not null,
  notes_md        text not null default '',
  metadata        jsonb not null default '{}',
  updated_at      timestamptz not null,
  unique (character_id, story_id)
)

place_story_notes (
  id              uuid primary key,
  place_id        uuid references places(id) not null,
  story_id        uuid references stories(id) not null,
  notes_md        text not null default '',
  metadata        jsonb not null default '{}',
  updated_at      timestamptz not null,
  unique (place_id, story_id)
)

lore_story_notes (
  id              uuid primary key,
  lore_entry_id   uuid references lore_entries(id) not null,
  story_id        uuid references stories(id) not null,
  notes_md        text not null default '',
  metadata        jsonb not null default '{}',
  updated_at      timestamptz not null,
  unique (lore_entry_id, story_id)
)
```

Identity is universe-scoped; context is story-scoped. The entity editor merges base and story-specific notes into one view.

### Declared story membership

Mention detection in scenes drives most "appears in story N" inference automatically. Users can also declare membership manually before any scenes are written.

```sql
character_story_memberships (
  character_id    uuid references characters(id) not null,
  story_id        uuid references stories(id) not null,
  declared_at     timestamptz not null,
  primary key (character_id, story_id)
)

place_story_memberships (
  place_id        uuid references places(id) not null,
  story_id        uuid references stories(id) not null,
  declared_at     timestamptz not null,
  primary key (place_id, story_id)
)
```

Membership is the explicit "this universe entity belongs to this story" signal; mentions are the derived one. The app writes a membership row when you create an entity while working in a story, or when you add an existing universe entity to a story, and you can remove one. "Does character X appear in story Y?" is answered by declared membership OR presence in `entity_mentions` for a scene in Y. The story-level Plan view is exactly this set: the universe entities that are members of, or mentioned in, the story.

---

## Entity relationships

Explicit, user-declared relations between entities — character-to-character (parent, sibling, rival, ally, mentor, serves), character-to-place (born in, raised in, lives in, rules, exiled from), and place-to-place (part of). Distinct from `entity_mentions`, which are implicit co-occurrences derived from prose. Relationships are data the user enters; mentions are data the system discovers.

```sql
relation_types (
  id                uuid primary key,
  universe_id       uuid references universes(id),   -- null for built-ins, set for user-added
  key               text not null,                   -- 'parent_of', 'lives_in', etc.
  forward_label     text not null,                   -- "parent of"
  reverse_label     text,                            -- "child of" (null when bidirectional)
  bidirectional     boolean not null default false,  -- true for sibling, friend, rival, etc.
  from_type         text not null,                   -- 'character' | 'place' | 'lore_entry'
  to_type           text not null,
  category          text,                            -- 'family' | 'social' | 'geography' (for UI grouping)
  sort_order        int,
  created_at        timestamptz not null,
  unique (universe_id, key)
)

entity_relationships (
  id              uuid primary key,
  universe_id     uuid references universes(id) not null,
  owner_id        uuid references users(id) not null,
  from_type       text not null,
  from_id         uuid not null,
  to_type         text not null,
  to_id           uuid not null,
  relation_type   uuid references relation_types(id) not null,
  story_id        uuid references stories(id),   -- null = universe-wide
  notes_md        text,
  created_at      timestamptz not null,
  updated_at      timestamptz not null
)

-- indexes on (from_type, from_id), (to_type, to_id), and (universe_id, story_id) for scope queries
```

Key points:

- **Direction.** Directional relations store one row; the UI renders the inverse on the target entity's page using the `reverse_label`. Symmetric relations (sibling, friend, rival) have `bidirectional = true`, store one row, and render with the same `forward_label` on both ends.
- **Built-in vs custom.** A seed migration populates `relation_types` with `universe_id = null` for a standard library (parent_of, sibling_of, spouse_of, friend_of, rival_of, enemy_of, ally_of, mentor_of, serves, born_in, raised_in, lives_in, rules, exiled_from, part_of). Universes can add their own with `universe_id` set — "apprentice of," "sworn sword of," "forged by," whatever the universe needs. This mirrors how entity categories work.
- **Story scope.** The `story_id` column lets a relationship be scoped to a specific book — "Alice and Bram are reconciled" in book two even though they're rivals at the universe level. Story-scoped rows supersede universe-wide rows where both exist, on the story's pages; the universe's page always shows the universe-wide truth.
- **No end-dating yet.** Relationships are either true (row exists) or not (row doesn't). Temporal relationships ("Alice and Bram were rivals until year 1472") can be handled via the notes field in v1, and potentially promoted to first-class time bounds later.

The UI never lets users enter free-form relation labels. The relation type itself is always picked from the defined set (built-in or custom); free-form context goes in the `notes_md` field. This preserves the ability to filter, graph, and inverse-render.

---

## Outline

Tree structure, independent of chapter/scene organisation. The outline can precede or diverge from the drafted structure.

```sql
outline_nodes (
  id                  uuid primary key,
  story_id            uuid references stories(id) not null,
  parent_id           uuid references outline_nodes(id),
  position            int not null,
  title               text not null,
  body_md             text,
  linked_scene_id     uuid references scenes(id),
  linked_chapter_id   uuid references chapters(id),
  metadata            jsonb not null default '{}',
  updated_at          timestamptz not null
)
```

---

## Notes

Freeform writer notes, scoped by whichever foreign key is populated. A note with only `universe_id` set is universe-wide; one with `story_id` set is story-specific; one with `scene_id` set is attached to that scene. All four foreign keys are nullable — the populated ones define the scope.

```sql
notes (
  id            uuid primary key,
  owner_id      uuid references users(id) not null,
  universe_id   uuid references universes(id),
  story_id      uuid references stories(id),
  chapter_id    uuid references chapters(id),
  scene_id      uuid references scenes(id),
  title         text,
  body_md       text not null default '',
  pinned        boolean not null default false,
  created_at    timestamptz not null,
  updated_at    timestamptz not null
)
```

The Notes sidebar tab filters by current context (e.g. showing scene-level and story-level notes when a scene is open) with an option to broaden the view to universe-wide.

These are distinct from the review comments below. Notes are writer-facing and freeform; review comments are reviewer-facing, position-anchored, threaded, and resolvable.

---

## TODO markers

A writer can flag a spot to return to, either by selecting text and marking it or by writing a line that begins `TODO:`. Markers show inline in the editor and collect in a per-story list. The plain-text form survives export because it is just text; the structured row below adds the checkable state and the highlight.

```sql
scene_markers (
  id            uuid primary key,
  scene_id      uuid references scenes(id) not null,
  owner_id      uuid references users(id) not null,
  kind          text not null default 'todo',  -- 'todo' | 'note' | 'flag'
  anchor_start  int,
  anchor_end    int,
  body_md       text,                          -- optional note on the marker
  resolved_at   timestamptz,
  created_at    timestamptz not null,
  updated_at    timestamptz not null
)
```

---

## Review and collaboration (deferred)

An author can invite a guest to review a single story. The guest may already be a Codex user or not; either way they are not forced to create an account. Access is by magic link, scoped to that one story, comment and suggest only, never the rest of the owner's data. Review is async, in the spirit of tracked changes and threaded comments in a word processor. None of this is in v1; the tables are reserved so the feature can be added without migrating live data.

```sql
review_invitations (
  id            uuid primary key,
  story_id      uuid references stories(id) not null,
  created_by    uuid references users(id) not null,   -- the author
  token_hash    text not null,             -- the magic link; only the hash is stored
  email         text,                      -- optional, who it was sent to
  can_suggest   boolean not null default true,  -- false = comments only
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null
)

reviewers (
  id             uuid primary key,
  invitation_id  uuid references review_invitations(id) not null,
  user_id        uuid references users(id),  -- set if the guest is a signed-in user; null for a non-user guest
  display_name   text not null,              -- captured for non-users
  email          text,
  created_at     timestamptz not null,
  last_seen_at   timestamptz
)

review_threads (
  id                  uuid primary key,
  story_id            uuid references stories(id) not null,
  scene_id            uuid references scenes(id) not null,
  anchor_start        int,                   -- character range in body_md; null for a whole-scene comment
  anchor_end          int,
  base_revision_id    uuid references revisions(id),  -- the text the anchor was placed against
  resolved_at         timestamptz,
  resolved_by_user_id uuid references users(id),
  created_at          timestamptz not null
)

review_comments (
  id                 uuid primary key,
  thread_id          uuid references review_threads(id) not null,
  author_user_id     uuid references users(id),      -- the owner, or a signed-in commenter
  author_reviewer_id uuid references reviewers(id),  -- an invited reviewer
  body_md            text not null,
  created_at         timestamptz not null,
  updated_at         timestamptz not null
  -- exactly one of author_user_id / author_reviewer_id is set
)

review_suggestions (
  id                 uuid primary key,
  story_id           uuid references stories(id) not null,
  scene_id           uuid references scenes(id) not null,
  reviewer_id        uuid references reviewers(id) not null,
  base_revision_id   uuid references revisions(id) not null,  -- the text the suggestion was made against
  range_start        int not null,
  range_end          int not null,           -- == range_start for a pure insertion
  replacement        text not null default '', -- '' for a pure deletion
  status             text not null default 'pending',  -- 'pending' | 'accepted' | 'rejected'
  decided_by_user_id uuid references users(id),
  decided_at         timestamptz,
  created_at         timestamptz not null
)
```

Key points:

- **No direct guest writes.** A reviewer never edits `body_md`. Their changes are `review_suggestions` the author accepts or rejects one at a time, which is what makes them attributable and reversible.
- **Attribution across users and guests.** Every comment and suggestion points at the person who made it (a `reviewers` row, or a user for the owner), so the author can always see which edits came from whom.
- **Async anchoring.** Comments and suggestions are pinned to a `base_revision_id`. When the author opens the review, anything whose offsets no longer fit the current text is re-anchored by diffing the base against the current revision, and anything that cannot be placed is flagged rather than applied. This works because no two people edit at the same time.
- **Guests are personal data.** Reviewer rows and their contributions fall under the cascade and erasure rules; revoking an invitation or deleting the story removes them.

This supersedes the single-row annotation placeholder that earlier drafts reserved for a reviewer role.

---

## Revisions (version history)

One polymorphic table covers history for every entity type with editable prose. Powers the VS Code-style timeline view.

```sql
revisions (
  id            uuid primary key,
  entity_type   text not null,   -- 'scene' | 'character' | 'place' | 'lore_entry' | 'outline_node' | 'chapter' | 'note'
  entity_id     uuid not null,
  body_md       text not null,
  reason        text,            -- 'autosave' | 'manual_checkpoint' | 'pre_import' etc
  created_at    timestamptz not null
)

-- index on (entity_type, entity_id, created_at desc) for timeline queries
```

Inserted on debounced save. Later optimisation: snapshot every N revisions, store diffs between snapshots. Don't bother until the table grows large.

---

## Mentions index

Rebuilt on every debounced save. Powers "find usages" and "appears in" for characters, places, and lore entries. Also drives the CodeMirror mention decoration plugin.

```sql
entity_mentions (
  id                  uuid primary key,
  source_type         text not null,   -- 'scene' | 'outline_node' | 'note' etc
  source_id           uuid not null,
  target_type         text not null,   -- 'character' | 'place' | 'lore_entry'
  target_id           uuid not null,
  position            int not null,    -- character offset in body_md
  surrounding_text    text not null    -- snippet for preview
)

-- index on (target_type, target_id) for "find usages"
-- index on (source_type, source_id) for "in this scene"
```

When a scene's `body_md` changes: delete existing rows for that source, then insert fresh ones based on name, alias, and keyword matching. Combined with full-text search on `body_md` columns, this gives both exact-entity and fuzzy in-text search.

---

## Assets and images

Codex stores uploaded images so a universe stays self-contained and travels with its export. Image bytes live in a storage backend (local disk for self-host, S3-compatible object storage for the hosted service, behind one small abstraction); only metadata lives in Postgres. Prose references an image by a stable app-served path, which the exporter rewrites to a file inside the markdown archive.

```sql
assets (
  id            uuid primary key,
  owner_id      uuid references users(id) not null,
  universe_id   uuid references universes(id),   -- scope; null for account-level images such as an avatar
  kind          text not null,                   -- 'cover' | 'inline' | 'avatar' | ...
  filename      text not null,
  content_type  text not null,
  byte_size     bigint not null,
  storage_key   text not null,                   -- path or key in the storage backend
  width         int,
  height        int,
  created_at    timestamptz not null
)
```

- **Covers.** `stories.cover_asset_id` points at a cover image. When it is null, the app renders a default cover from the title and author, so every book on a shelf has one.
- **Inline images.** The markdown editor inserts an uploaded image as a normal markdown image whose URL is an app-served asset path (for example `/assets/{id}`). Pasting an external image URL is also allowed, but only uploaded assets are stored, exported, and guaranteed not to rot.
- **Export.** A markdown export writes referenced assets into an `assets/` folder in the zip and rewrites the links, keeping the archive self-contained and Obsidian-friendly.

---

## Public reading pages

A writer can publish finished work to a public reading page (see `design.md`). Publishing freezes the current prose into a read-only edition stored separately from the live tables, so the reader path never reads draft content and never joins back to the editing tables.

```sql
publications (
  id              uuid primary key,
  story_id        uuid references stories(id) not null,
  owner_id        uuid references users(id) not null,
  handle          text not null,         -- denormalised from users.handle for the reader path
  title           text not null,
  author          text,
  description_md  text,
  is_adult        boolean not null default false,  -- carried from stories.is_adult; lets the reader site filter
  content         jsonb not null,        -- frozen chapters and scenes for this edition
  version_label   text,                  -- optional, e.g. 'Edition 2'
  is_current      boolean not null default true,
  removed_at      timestamptz,           -- set by an admin takedown; hides the edition without deleting the source
  published_at    timestamptz not null
)

-- index on (handle) for profile lookups
-- index on (story_id, is_current) for the current edition of a story
```

Key points:

- **Snapshot, not live.** Each publish writes a new `publications` row capturing the prose at that moment, and clears `is_current` on the previous edition. Readers see the current edition; the live `scenes` and worldbuilding tables are never exposed.
- **Prose only.** `content` holds the story's chapters and scenes. Characters, places, and lore are not included in v1.
- **Visibility.** `stories.visibility` decides whether a story is private, reachable only by direct link (unlisted), or listed on the author's public shelf (public).
- **Adult content.** `is_adult` is carried from the story so the reader site can keep adult work out of default listings and behind a confirmation. It marks content, it does not ban it.
- **Hosted vs self-host.** On a self-hosted instance these rows are read directly. On the hosted service the worker syncs them to a central reader site keyed by `handle`. Either way the rows have the same shape.

---

## Multi-tenancy

- The application is single-operator and multi-user: `owner_id` separates one user's data from another's within an instance. On the hosted service, separate customers (tenants) are isolated at the instance and database level rather than by a shared-table filter (see `design.md`), so `owner_id` never carries a cross-tenant boundary.
- Every user-owned table has an `owner_id`.
- All queries filter by owner at the universe level, with cascading access through stories, scenes, and entities.
- Guest review access (see Review and collaboration) is granted per story through an invitation rather than by sharing ownership. Authorization checks are intentionally kept in one service layer, so adding that access later is a small, contained change.
- Admin approval is a flag on the `users` table. The approval workflow can be managed via direct SQL for a long time before needing a UI.

---

## Export

Not a storage concern, but noted for portability. A story or universe should be exportable as a zip of markdown files with YAML front matter (chapters/, scenes/, characters/, etc), matching an Obsidian-compatible structure. EPUB export via Pandoc or a Node EPUB library. Postgres is the running format, optimised for the app; export produces the portable artefact on demand.

### Account export and deletion

A user can export everything they own (every universe, story, scene, entity, note, and uploaded asset) as a single archive. Deletion is a hard delete, not a soft flag, to satisfy GDPR erasure: removing a user removes every row they own, cascading from universes down through stories, scenes, chapters, entities, relationships, notes, mentions, revisions, publications, and assets, and also removes their uploaded files from the storage backend. On the hosted service, deletion additionally purges any synced editions and assets from the central reader store, so nothing survives in the public archive. Foreign keys are defined with `on delete cascade` along ownership paths so a single delete is complete and leaves no orphans.

---

## Open questions

- How aggressive should autosave revisioning be? Every debounce save is probably too much over long sessions. Every N seconds of idle, plus on-blur and on-navigation, is likely right.
- Should revisions be per-entity or per-save-batch? If saving a scene triggers a mentions rebuild, those are logically one edit. A batch ID on the revision row would group them.
- Whether plotlines/arcs eventually become first-class entities (a join table on scenes) or stay in `metadata` jsonb.
- Scene-at-a-time vs continuous-scroll as the default writing mode. `global_position` supports both; it's a rendering decision, not a schema one.