# Codex — design

A writing workspace for long-form creative work — novels, serials, campaigns, worldbuilding projects that grow across years. Runs in Docker, accessed through a browser. Two ways to use it: install it on a server you control, or sign up on the hosted service run by the project maintainer. Same code either way, same features, MIT-licensed. There is no feature-gated tier; the difference between the two paths is who handles backups, TLS, and updates.

Companion documents:
- `schema.md` — full Postgres schema.
- `roadmap.md` — phased build sequence.

---

## What Codex is

Codex sits between the formal tools that treat writing as a deliverable (Scrivener, Final Draft) and the prose editors that treat writing as a single document (markdown editors, Word). What it adds is structure: a **universe** that holds shared worldbuilding, **stories** that tell specific narratives within that universe, **chapters** and **scenes** that carry the prose, and **characters, places, and lore entries** — cross-referenced, searchable, visible alongside the writing surface without crowding it.

It is not a chat tool. It is not a role-play tool. It is not, principally, a publishing platform — though it exports what you need to take your work elsewhere. The shape is the same whether you self-host or use the hosted service: one shared instance with a number of accounts on it, each user's work scoped to them and private by default, and published pages reachable by anyone (the GitHub model). What differs between self-host and hosted is only who is responsible for the box it runs on, not the model.

## Who uses it

Three types of user shape the product, and in practice they overlap — most people using Codex will be some combination of all three at different moments.

**The novelist** writes long-form fiction, sometimes standalone, often series. They care about prose quality, consistent worldbuilding across books, finding every mention of a character to verify a detail, and recovering a draft from a week ago because the restructure didn't actually work. They protect their flow state and bristle at anything that interrupts it.

**The worldbuilder** may or may not be writing a specific story. What they're building is the world itself — its geography, its histories, its factions, its magic or its science. They want to hold their material in structured form and link it together. For them the stories (if any) are a way to explore the world; the world is the primary thing.

**The TTRPG designer or DM** is running a campaign, writing a setting book, or both. They share a lot with the worldbuilder and some with the novelist — session recaps, NPC journals, faction politics, encounter notes. They want to record canon without being forced into a novel-shaped "story" structure.

Codex does not ask you to pick a lane. It gives you primitives and lets you use them however fits. A novelist's *series bible* and a DM's *campaign setting* map cleanly onto the same concept — a universe with characters, places, and lore, and any number of story-shaped containers drawing from it.

## What it feels like to use

### Starting fresh

You land on your library. It shows the universes you've already created — "The shattered realms," "Tenfold moon" — each with its cluster of stories, plus any standalones. There is a dashed-border button at the top right: *New universe*. You click it, name it *The long cold*, add three sentences of description, and create your first story inside it. An empty scene is already waiting when you land in the writing view: status *outline*, position zero, untitled. You start typing.

### Drafting

Forty minutes in. The editor has underlined — in quiet category colours, dotted not solid — the names of characters and places you've introduced earlier. The first time you type "Hal" in this scene, a faded "den" appears after your cursor; Tab makes it "Halden." An hour later you decide to restructure the opening. Before you rewrite, you open the History tab in the right sidebar and add a manual checkpoint called "before restructure." You rewrite. Two hours after that, you realise the original was actually better. You open the History tab again, click the "before restructure" entry, see the earlier version in the centre column with a blue *Viewing a past revision* banner, and click *Restore*. Nothing is lost; your restructured attempt becomes a new revision in the timeline, still recoverable.

### Coming back

Three weeks later you open Codex. Your library's *Recent* strip shows *Book of ash* at the top — "edited 3 weeks ago." You click in. The scene you were working on is still open. The right sidebar panels you had pinned are still pinned. Your entity underlines are still there. You pick up without orientation.

### Stretching across books

A year later you start *The northern march*, book two in the same universe. You add it as a second story under *The shattered realms*. Alice, Halden, the treaty — all already exist; you don't re-describe them. But in this new book, Alice is seven years older and living somewhere else. You open her entity page; in the *In this book* section (story-scoped, visually distinct with a left accent) you write what's changed for her. Book one's notes are untouched.

### Just writing

Codex has no AI features in v1. You sit down to write and the tool gives you a focused editor with your worldbuilding within arm's reach. No suggestions appear unbidden. No chat panel sits in the corner waiting. The Session tab in the right sidebar holds your quick preferences — entity-autocomplete style (the local, lookup-based kind), whether entity underlines show, theme, focus mode — and that's all that lives there. LLM assistance is on the roadmap but deliberately deferred: the writing experience has to be good on its own merits first, and the prose corpus that emerges from real use is the best calibration material for whatever assistance eventually arrives. When that day comes, AI will be opt-in per account and per story; a user who keeps it off will continue to see no AI UI anywhere.

### Turning over a universe

Years in, your universe has grown large enough that you want to share it. You open universe settings, go to Export, and download a markdown archive — a zip of plain markdown files, each with YAML front matter, organised into folders for characters, places, lore, and a subfolder per story. The archive opens cleanly in Obsidian. You hand it to a friend, who reads through it without needing to run Codex at all. Your words have never been trapped.

## Product structure

```
universe
  ├── story (one or more)
  │     ├── chapter (organisational container)
  │     │     └── scene (atomic writing unit)
  │     └── outline nodes
  └── characters, places, lore entries (universe-scoped; surfaced per story by reference)
```

A few decisions this shape encodes:

**Universe, not "book" or "series.**" The container holds shared worldbuilding, and books or series are subsets of that. A single novel has a universe of its own, implicitly. A series has one universe with multiple stories. A TTRPG setting is a universe with no stories at all, or with an ongoing "campaign" story that accumulates session notes.

**Story, not "novel.**" Form-agnostic. Novels, novellas, serials, short stories, and campaigns all fit.

**Scene, not chapter, is the atomic writing unit.** Scenes own prose. Chapters are organisational. A scene has POV, location, time, status, word count, and an optional summary. Chapters are parents that can be reordered and summarised. This is Scrivener's instinct and it's correct — scenes are the unit of writing.

**Orphan scenes are allowed.** A scene's `chapter_id` is nullable, so you can draft before committing to chapter structure.

**Characters, places, and lore are universe-scoped, surfaced per story by reference.** Alice-at-32 and Alice-at-39 are the same character record, with per-book notes layered on top. Identity lives on the universe; context lives on the story. A story does not own its own entities: its Plan view shows the universe entities it declares as members or mentions in prose, and creating an entity while inside a story simply adds it to the universe and marks it a member of that story.

**Lore categories are user-defined.** Every universe starts with a single "Lore" category; users rename it, delete it, and add as many more as they need — "Factions," "Rituals," "Technologies," "Historical events." Characters and places stay first-class because they have behaviours (aliases, mention detection, POV assignment) the generic lore shape doesn't need.

## The writing surface

The editor exists at two scopes: **story** and **universe**. Both use the same three-column shell — structure on the left, working area in the centre, reference on the right — and the same underlying components. What differs is which views are available and what the components display.

**Inside a story**, the editor offers three views, selected by tabs at the top of the left sidebar:

- **Write** shows the manuscript tree (chapters and scenes) on the left, a markdown editor on the centre column rendered in Literata, and reference panels on the right (pinned entities, universe summary, category catalogues, mentions in this scene).
- **Plan** swaps the left sidebar for a list of the story's entities (the universe entities it uses, grouped by category) and the centre column for an entity editor with fields for summary, body, aliases, story-specific notes, and relationships. Right sidebar shows mentions and relations.
- **Notes** shows freeform notes grouped by pinned and recent, with the same prose-first editor in the centre. Notes can be scoped to the universe, the story, or a specific scene.

**Inside a universe**, the editor offers two of those views — **Plan** and **Notes** — without Write. A universe doesn't contain prose directly; it contains the worldbuilding that stories draw on. The universe-level Plan is the same entity editor component as the story-level Plan, except it shows every entity in the universe (rather than the subset a story uses) and hides the *In this book* story-scoped section (there's no story context at this scope to define "in this book" against). The universe-level Notes is the same notes component, filtered to notes that aren't attached to any specific story.

This structure — universes as first-class editable surfaces, not just settings containers — is important for worldbuilders and TTRPG designers who may never write a prose "story" but need a full editor for characters, places, and lore. It's also important for novelists adding a character who'll cross multiple books: the natural home for such a character is the universe, not whichever book they happened to appear in first.

Across every view at either scope, the right sidebar has three tabs: **Reference** (panels for what's in view), **History** (the revision timeline for whatever is currently being edited), and **Session** (quick settings that govern how you're working in this moment). Each tab has a distinct semantic axis: *what's in view*, *what was in view*, and *how you're working with it*. A fourth surface many apps ship — a command palette — is deferred, not in v1.

### The Session tab

The Session tab is where the preferences that actually change mid-session live — the ones too fussy to justify walking through full settings for, but too important not to be reachable in one click.

Four quick-settings controls sit at the top: **entity autocomplete** (off / inline ghost-text / popup menu), **underline known entities** (toggle), **theme** (auto / light / dark), and **focus mode** (toggle). Each has a canonical home in full settings; Session just surfaces the commonly-flipped ones. Changes apply forward, not retroactively — switching autocomplete style mid-sentence affects the next suggestion, not the one currently on screen.

Below the quick settings, the Session tab is intentionally empty in v1. It is the eventual home of an LLM chat surface (rubber duck, co-author, editor roles) when that work is taken on; for now, leaving the space reserved keeps the tab's purpose clear without rushing the feature behind it. An *AI assistance for this story* toggle will join the quick settings above when there is something to toggle.

### Entity mentions

The feature that ties planning and writing together. Each scene is scanned on debounced save for known entity names and aliases. Matches are stored in an index table and rendered live in the CodeMirror editor as dotted underlines in the entity's category colour. Hovering shows a short popover with the entity's summary; clicking opens it in the reference panel or jumps to its entry.

A per-entity `auto_detect_mentions` flag disables matching for common-word names ("Will," "Art," "Rose") where you don't want false positives. Aliases are first-class: Mrs. Fenwick and Alice are the same person, and both trigger the underline.

### Entity relationships

Where mentions are *implicit* links derived from prose, relationships are **explicit** links declared by the user. A character is the parent of another character; a character lives in a place; a place is part of a larger place. Relationships are the worldbuilding equivalent of mentions: they cross-reference entities, but the user enters them directly rather than the system discovering them.

Each relationship has a typed label from a defined set — *parent of, sibling of, rival of, lives in, rules, part of,* and so on — plus optional free-text notes. The relation types ship with sensible built-in defaults (family, social, geography) and can be extended per-universe; a universe about sworn-sword hierarchies or starship crews can add the types that fit it without the tool privileging any particular genre. Direction matters: *parent of* is asymmetric, rendered as "child of" on the target's page; *sibling of* is symmetric, rendered the same on both sides. The free-text label is never user-typed — it's always picked from the defined set, so relationships stay filterable, inverse-renderable, and eventually graphable.

Relationships can be scoped to a specific story, so a reconciliation in book two doesn't have to rewrite the universe-level rival relationship that's true across the broader canon. Story-scoped relationships supersede universe-wide ones on that story's pages.

The entity editor shows relationships as a dedicated section below the Description. The Reference panel in the right sidebar shows them alongside the mention-derived "Related" list — relationships in one group, mention co-occurrences in another, visually distinct so the user can tell which links are authored and which are discovered.

### Entity autocomplete

Building on the mention index, the editor also offers completion suggestions while you type. The behaviour is user-configurable through a three-option preference: **off**, **inline ghost-text**, or **popup menu**. Ghost-text is the recommended default for prose — the rest of "Halden" appears as faded text after your cursor when you type "Hal," and Tab accepts it. The popup is a dropdown showing multiple matches with arrow-key selection, more familiar to anyone coming from IDEs. Off disables the feature without affecting the underlines. The three options are exposed because writers genuinely disagree on the best shape, and CodeMirror's compartment-based configuration makes them cheap to switch between.

### History

Every debounced save produces a revision. Manual checkpoints can be added at any time with a short label. Revisions are polymorphic across every editable entity — scenes, chapters, characters, places, lore entries, outline nodes, notes — and surface at three scopes:

- **Per-item** via the History tab in the right sidebar: shows the timeline for whatever is currently open.
- **Per-story** via the History section of story settings: every revision in every scene, chapter, and story-scoped note, across time.
- **Per-universe** via the History section of universe settings: broadens the same lens to every change anywhere in the universe, including worldbuilding entities.

Autosaves are pruned after ninety days; manual checkpoints are kept indefinitely. A selected revision can be previewed in the centre column (with a clear banner indicating preview mode) or restored — which, crucially, creates a new revision on top of the current one rather than overwriting it. Restoration is therefore reversible.

A diff view sits alongside the timeline. Any two revisions can be compared, and a previewed revision is shown as a diff against the current text by default, with insertions and deletions marked inline. It is the same diff component wherever changes need to be shown, including a reviewer's suggested edits (see the deferred review feature in `schema.md`), so it is built once and reused.

### Focus mode

A button in the top bar hides both sidebars using `visibility: hidden` rather than `display: none`, so the prose column stays anchored where it was instead of shifting to the new centre of a now-wider grid. The mode doesn't widen the prose — it removes the chrome around it. The content width setting controls how wide the prose column actually is, independently of focus.

### Continuous view

The Write view can also show the whole story as one continuous document: scenes flow together in story order, chapter titles act as section headings, and the sidebar becomes navigation, scrolling to whatever it names. The point is reading a draft the way a reader will meet it; editing stays in the scene-at-a-time view, one click away from any scene, and toggling back returns to the scene that was open. Whether scene marks render inside the flow is a display preference: some authors treat scenes as atomic splits that should not interrupt the reading flow. The rendering is driven by `global_position`, so reordering scenes reorders the reading flow. Editing inside the continuous view (stitched per-scene editors, each autosaving separately) is scheduled as roadmap step 23b.

### Images

Codex is a markdown editor, so an image is just a markdown image. What Codex adds is storage: an image dropped or pasted into the editor is uploaded and kept as an asset, and the markdown points at a path Codex serves rather than at someone else's server. This keeps a universe self-contained, lets images show up in exports, and stops links from rotting. Pasting an external image URL still works when that is what you want; it simply is not stored. Each story can also carry a cover image, and a book without one is shown with a default cover built from its title and author so a shelf never looks broken. Image files live on disk for self-host and in object storage for the hosted service; only their metadata is in the database. See `schema.md` for the `assets` table.

### TODO markers

While drafting you can mark a spot to come back to. Selecting text and flagging it, or typing a line that begins `TODO:`, records a marker that shows as a highlight in the prose and as an entry in a per-story TODO list you can scan at a glance. A marker can carry a short note and be checked off when done. Because the plain-text form is just text, markers survive a markdown export; the structured form (see `schema.md`, `scene_markers`) adds the checkable list and the highlight.

## Accounts and access

Codex assumes accounts. The same surfaces serve self-host users and hosted-instance users; only the operator differs.

**Sign-up.** A public sign-up page captures email, password, and display name. The account is created but unapproved: a row with `approved_at = null`. Until the operator approves, sign-in is blocked with a "your account is pending review" message. Email verification runs in parallel: a confirmation link is sent on sign-up, clicking it sets `email_verified_at`. Both gates have to pass before sign-in succeeds. The current `users.role` and `users.approved_at` columns already model this; the work is the UI, not the schema.

**Approval.** A small admin page lists pending accounts with name, email, sign-up time, and approve/reject buttons. For an operator running an instance for friends, "I get a notification when someone signs up, I look at the email, I click approve" is the whole workflow. Self-rejection on the admin's part also exists for clearing out spam attempts. Invite codes are a deferred alternative: a future `invite_codes` table can short-circuit the approval gate when a valid code is presented on sign-up, but it's not v1.

**Sign-in, password reset, sessions.** Standard session-based flows: a session cookie issued after sign-in, "forgot password" with email link, password reset, sign-out. Nothing custom unless something specifically needs it.

**Account self-service.** Each account has a settings page: change display name, change password, change email (with re-verification), manage two-factor methods (an authenticator app or a passkey), review and revoke active sessions, set a public handle, and set display preferences. Two destructive actions live in a separate "danger zone": export everything I own (a single archive of every universe, story, scene, entity, note, and uploaded image as markdown with front matter) and delete my account. Deletion is a hard delete with a confirmation step, not a soft flag: it removes every row and file the account owns, and on the hosted service it also purges anything that user published from the public archive. This is what lets the tool answer cleanly to a GDPR erasure request; if you want your data back, export first.

**Plans, entitlements, and quotas.** What a user may do is expressed through a plan and its entitlements (see `schema.md`), modelled from the start so the shape is settled before it is needed. Every user is on a plan; the default plan grants everything, which is the right setting for self-host. Enforcement (rejecting a save or a create that exceeds an entitlement) is deferred until a real user makes it necessary, and billing is deferred further still: there is no payment processing and no Stripe in the foreseeable plan. A subscription layer, if it ever arrives, sets a user's `plan_id` without disturbing the rest of the model. Exploring a paid hosted tier is a deliberate someday, not a launch concern.

**Distinct from collaboration.** None of the account surfaces here support shared editing or shared ownership of content. Every universe and story has a single `owner_id`. A future guest-review role is modelled in the schema but deferred: an author can invite someone (an existing user or not) to comment in threads and propose suggested edits on a single story, without that guest gaining an account or write access to the prose. See Review and collaboration in `schema.md`.

## Public reading pages

Codex assumes private writing, but a writer can choose to share finished work as a public reading page. This brings in a new kind of person: a reader, with no account, who follows a link, reads, and never opens the writing app. Their experience is deliberately separate from the author's.

**Publishing is gated.** A user cannot publish to the public web until an admin enables a public archive for their account. This gives the operator a chance to look over what someone intends to share before it is reachable at a public URL, which is the main lever for keeping material that should not be there (someone uploading a novel that is not theirs, for instance) off the instance. The gate applies to every public page, independent of adult content. The operator also keeps a takedown: an admin can remove a published edition, which hides it without destroying the author's own copy.

**The shelf.** An author can claim a handle and turn on a public profile at `/@handle`. The profile is a simple shelf: an optional short bio, then the universes that contain at least one shared story, and under each the stories the author has chosen to make public. A reader picks a story and reads it: chapters in order, scenes flowed together, set in the same Literata prose face as the editor, with none of the sidebars or worldbuilding around it.

**Publishing is a snapshot, not a live view.** Making a story public does not expose whatever is currently on the editing screen. Publishing freezes the present text into a read-only edition; the author re-publishes to push a new edition, which is how a serial author releases the next chapter. Readers only ever see what was deliberately released, in-progress drafts never leak, and the reading path reads only from the frozen editions rather than the live editing tables. A frozen edition is small (markdown plus a little metadata), so it is cheap to cache and serve.

**Prose only, for now.** A public page shows a story's text and nothing else. Characters, places, and lore stay private, since they are often spoilers or unpublished invention. A public, read-only world wiki that shares selected worldbuilding, for the worldbuilder and TTRPG audiences, is an appealing later addition but is explicitly not part of the first version.

**Visibility per story.** A story is private by default. It can be made unlisted (reachable only by direct link, not shown on the shelf, useful for handing a draft to one person) or public (listed on the shelf).

**Adult content.** A story can be flagged as adult by its author. Codex does not ban it, but the reader site keeps flagged work out of default listings and shows a short confirmation before opening it, so a reader who wants to avoid it can. The flag travels with the published edition.

**Accessibility.** The reader pages are a public reading surface, so they meet WCAG 2.1 AA. That means semantic HTML with a correct heading outline and landmark regions, a keyboard-operable page with visible focus, text and controls that clear AA contrast in both themes, alt text on covers (including the generated default), a `lang` attribute on the prose, and respect for `prefers-color-scheme` and `prefers-reduced-motion`. The adult-content confirmation is part of this: it is reachable and operable by keyboard and announced to assistive technology, not a mouse-only overlay.

A few smaller rules round this out. Handles come from a reserved list so application routes (sign-in, settings, and the like) can never be claimed; changing a handle is allowed but breaks old links. Adult pages are served with a noindex instruction so search engines do not surface them. And there is, by design, no site-wide directory or search: the only routes to a reader page are an author's handle and a direct link, so discovery across authors is deliberately out of scope.

The instance serves these `/@handle` pages directly for its own users, the same way whether self-hosted or hosted. They render only the frozen, published editions, never a draft, and handles are unique within the instance. (A central cross-instance handle registry would only matter if there were ever many separate instances sharing one public namespace, which the single-instance model does not need; see `roadmap.md`.)

## AI: deferred

Codex has no AI features in v1. The decision to defer is deliberate, not incidental. The editor and the planning surface have to be good on their own merits first; the prose corpus that emerges from real use is the best calibration material for whatever assistance eventually arrives; and the temptation to build the LLM gateway early is exactly the kind of interesting tangent that wrecks solo projects.

When that work is eventually taken on, the planned shape is:

1. **Off.** No LLM surfaces shown. Default for every account and every story.
2. **Rubber duck.** A side-panel chat in the Session tab, user-driven. No automatic context injection.
3. **Co-author.** A side-panel generation surface with insert/edit/reject flow, assembled with current-scene + chapter-summary + active-characters context.
4. **Continuation.** Inline ghost-text from the LLM, Tab to accept. Distinct from entity autocomplete, which is local and lookup-based and ships in v1.
5. **Editor.** Margin annotations on existing prose, no generation.

**BYO key.** Codex will not ship bundled AI when this lands. Users will configure their own OpenAI-compatible endpoint — Ollama on a local machine, a proper API provider, a self-hosted vLLM, anything with the right interface. The user's endpoint and key will be stored encrypted in their account settings, with per-story overrides for model selection.

**The schema already reserves space** for the configuration (`users.llm_config`, `stories.llm_config`) and for lore activation behaviour (`lore_entries.activation_mode`). Those columns exist now so the eventual feature doesn't require migrating live data; in v1 they're inert. See `schema.md`.

Two things to keep separate even in writing about the deferred feature: **entity autocomplete** (the ghost-text that completes known names) is local and lookup-based, has nothing to do with an LLM, and is in v1. **Continuation** is the LLM role that produces inline ghost-text and does not yet exist. The two share a UX pattern, not a backend.

## What Codex is not

- **Not a chat tool.** When AI eventually arrives, the rubber-duck role will be a writing aid, not a general-purpose chat. Users wanting a chat interface have better options.
- **Not a role-play tool.** Character dialogue belongs in the prose; no UI or schema supports character impersonation.
- **Not a book-distribution platform.** Codex can publish reading pages to the web (see Public reading pages) and export a markdown archive, but it does not push your book into stores or produce publisher-ready files. Export to formats like DOCX with manuscript standards or a properly formatted EPUB is a someday-maybe; the primary export path is the markdown archive.
- **Not a real-time collaboration tool.** Single-author-per-session is assumed. Review is async, not live: a future guest-review role lets an invited reviewer leave threaded comments and suggested edits that the author resolves in their own time, modelled in the schema but deferred. There is no simultaneous multi-author editing.
- **Not a feature-gated SaaS.** The hosted instance runs the same code anyone can install themselves, under the same MIT licence. There is no paid edition with extra features; if a difference between self-host and hosted ever appears, it will be operational (someone else runs the box) rather than functional (you get more features by paying).
- **Not a mobile editing app.** Phones are too small to draft on meaningfully. Tablets in desktop mode work for review but aren't prioritised for authoring in v1.

## Technical shape

- **Backend and UI:** SvelteKit on Node (current LTS), TypeScript across the whole app. Server-rendered pages and server endpoints live in one project, with a compiler-enforced split between server-only code (database access, secrets, session checks) and what ships to the browser. There is no separate frontend framework and no separate API service to run.
- **Database:** Postgres 18 (`postgres:18-alpine`). Content is stored as markdown in `text` columns; metadata in typed columns and `jsonb` where the shape is fluid.
- **Data layer:** Drizzle. Tables are defined in TypeScript close to the SQL in `schema.md`, and migrations are generated from those definitions. The queries stay thin and SQL-first, which keeps the database driver swappable (see the desktop build note in `roadmap.md`).
- **Editor:** CodeMirror 6, running in the browser. The editor's input loop is client-side; the server sees debounced saves posted to an endpoint, not keystrokes.
- **Background work:** a separate worker process handles jobs that do not belong in a request: mention-index rebuilds, transactional email, exports, backups, and the publication sync described under Public reading pages. The job queue runs on Postgres itself (pg-boss), so there is no extra infrastructure to run.
- **Auth:** server-side sessions keyed by a cookie, with passwords hashed using a vetted algorithm (argon2 or bcrypt). Sessions are revocable, so "log out everywhere" and admin revocation work, and two extra factors (an authenticator app for TOTP, and passkeys) are modelled from the start. The `users` table carries the role, approval, and email-verification columns the flows need, and an admin approval gate stands between a new account and an active one.
- **Testing:** three layers. Unit tests (Vitest) cover pure logic such as mention detection and markdown round-trip. Integration tests run against a real throwaway Postgres rather than a mock, since the data layer is thin and SQL-first and a mock would prove nothing. A small Playwright suite guards the critical journeys (sign in, create a story, draft a scene). Tests are written alongside the code, close to test-driven without being strict about it.
- **Deployment:** Docker Compose with four services: the SvelteKit app, the worker, Postgres, and Caddy as the reverse proxy for TLS. The same image runs on a home NUC for self-hosters and on the maintainer's infrastructure for the hosted service.
- **Licence:** MIT. The hosted service is offered as a convenience for users who do not want to run Docker, not as a paid edition. Anyone can take the source and run their own instance, public or private. (Modelled on Ghost rather than GitLab: same code in both places, no Community/Enterprise split.)

The stack is chosen to stay easy to maintain over a long-running project and approachable to anyone who helps later. One language across the whole app keeps the context small, and the editor, the hardest part, is native to that language rather than reached through an interop layer. The pieces are deliberately the settled, boring ones rather than the newest, since low churn matters more here than novelty. Heavier orchestration and microservices were considered and rejected as overkill for a four-service application.

### Hosting and tenancy

The application is single-operator and multi-user: one person runs an instance for themselves and any friends they invite, each of whom owns their own universes and stories. That is the self-host shape, and the hosted service is the same shape - the maintainer runs one instance and opens sign-up on it.

There is one instance and one database, shared by everyone on it, in the GitHub model: your work is scoped to you and private by default, and the pages you choose to publish are reachable by anyone. There is no fleet, no instance-per-user, and no control plane to provision or route tenants; the hosted service is simply this one application running, with accounts on it. Self-host and hosted run identical code.

Because the instance is shared, isolation is a property of the code rather than the deployment: every universe and story carries a single `owner_id`, and every query that reads or writes a user's private content is scoped to the signed-in owner. One user's unpublished work is kept out of another's reach by that scoping, so it has to hold on every path - which makes a deliberate cross-tenant isolation audit part of preparing the instance for sign-ups (see `roadmap.md`, Phase 5). The published `/@handle` reader pages are the only content that crosses between users, and only ever the frozen editions a user chose to make public.

Portability is achieved through export, not through storage format. The database is the running format; markdown archives and EPUB are the portable artefacts produced on demand. Version history is a polymorphic `revisions` table rather than Git.

## Open questions

- **Editing in the continuous view.** Resolved: the read-only continuous view shipped with the core writing loop, and author feedback confirmed editing in place is needed, scheduled as roadmap step 23b. What remains open is the default for scene marks inside the flow (shown or hidden) until the preferences UI exists to make it a choice.
- **Plotlines or arcs as first-class entities.** Currently modelled through scene tags and metadata `jsonb`. May be promoted to their own table if usage shows it's needed.
- **Command palette (Ctrl+K).** Desirable long-term, not v1. Would absorb search and cross-view navigation into one surface.
- **Session tab refinements (deferred with AI).** When a chat panel eventually lives below the quick settings, it will need persistence, resumption, and browsing of past conversations. The quick-settings portion may also need a collapse control once chat sessions grow long enough to compete for vertical space. None of this matters until the chat exists.
- **Entity colours with meaning.** Character badges currently take a deterministic colour from the name. The better model: universe-defined categories with chosen colours (the `entity_categories` table already carries `color` for lore), opened up so characters and places can optionally join one - a nullable `category_id`, purely additive. Grouping the cast by colour then carries whatever meaning the author gives it (factions, families, POV tiers). Falls naturally out of step 16, when the category machinery is built for lore.
- **How much markdown the editor should show.** Bodies are stored as markdown; today the editor shows the raw marks and the continuous view renders plain text. A proper renderer arrives with exports and the public reading pages (Phase 4), and the continuous view picks it up then. In-editor affordances (styled emphasis and headings while writing, the prototype's formatting toolbar) are candidates after that, and how much markup stays visible while writing is likely a display preference; worth testing on real authors before committing to a default.
- **Preference layering.** Display preferences live on the user (`users.preferences`), but several (content font, density, markdown affordance, scene marks in the continuous flow) plausibly want per-story overrides merged at render time, the same user-plus-story override pattern already modelled for `llm_config`. A story-level preferences column is an additive migration when this is built.
- **Sidebar resize.** Deferred. Current fixed widths (240 left, 280 right) are deliberately chosen; resize is polish.
- **How aggressive revision pruning should be.** Every debounced save is probably too granular at scale. Coalescing consecutive autosaves within a short window into a single revision is an optimisation that only matters once the table grows.
- **Guest review (reviewer role).** Schema reserves space for invitations, reviewers, comment threads, and suggested edits; the invite flow, the magic-link guest identity, and the accept/reject UI are deferred. Comments ship before suggested edits, which are the harder half.
