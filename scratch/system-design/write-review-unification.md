# Sidebar parity for Write and Review

Status: proposed, 2026-06-17 (revised same day after the owner ruled out merging
the two surfaces). Write and Review stay separate views; "Review" stays a peer
mode on the Write/Plan/Notes/Review strip. This note is now scoped to one thing:
making the two left sidebars uniform, including the right-click menu Review
lacks. Step 1 (below) already shipped.

## Why not merge (settled)

Folding Review into Write was considered and rejected. The reasons stand:
Review is a peer of Plan and Notes on the mode strip, not a twin of Write;
merging conflates "what I am doing with the manuscript" with "how I view this
scene"; and the guest reviewer needs a distinct, write-access-less surface
regardless. So both views remain. See the prior revision in git history for the
merge analysis.

## The problem we are fixing

The Write sidebar (`StoryOutline`) and the Review sidebar (`ReviewNav`) are two
separate implementations of the same chapter/scene tree. The base row CSS is
shared (one definition in `theme.css`), so they look close, but they drift in
behaviour and that reads as unfinished:

- Review has no right-click row menu (the owner's headline example).
- Review rows are `<button onclick>`, Write rows are `<a href>`.
- Review has no inline chapter rename, no create, no drag, no trash.
- Review shows review-activity counts; Write shows word counts.

The drift is structural: two components mean two places to keep in step, and
they have not stayed in step.

## Why Review cannot just bolt the menu on

`StoryRowMenu` and `StoryOutline`'s create/rename/trash forms post to
route-local form actions (`?/moveChapter`, `?/deleteChapter`, `?/deleteScene`,
`?/renameChapter`, `?/createScene`, ...). The Review route's `+page.server.ts`
has only review-thread actions. So the menu has nowhere to post on that route,
and several menu items (Rename chapter, merge highlighting) also need outline
state (`renamingChapterId`, `mergeSelection`) that `ReviewNav` does not have.
Retrofitting `ReviewNav` would mean re-adding all of that to the lesser
component.

## The decision

Use `StoryOutline` as the single outline for both routes and delete `ReviewNav`.
Two facts make this the path of least resistance rather than a big merge:

1. **Relative form actions.** `StoryOutline`/`StoryRowMenu` post to `?/action`,
   which targets the rendering route. Give the Review route the same-named
   actions (thin wrappers over `$lib/server/scene-lifecycle`, consolidated in
   step 1) and the menu, create, rename, and trash all work unchanged.
2. **`StoryOutline` already has the hard parts** the menu needs: the inline
   rename field, merge-selection highlighting, the row menu hook. `ReviewNav`
   has none of them.

`StoryOutline` grows a small capability surface so it can serve Review without
changing how it serves Write:

- `onSelectScene?` - when set, rows select in place (a `<button>`) instead of
  navigating (`<a href>`). Review keeps its in-page selection (no per-scene
  reload, so the filter and composer survive); Write keeps href navigation.
- `trailingMeta` snippet - word count on Write (default), review-activity count
  on Review.
- `header` - the book switcher on Write (default), a static book label on
  Review.
- `canManage` - gates the menu, drag, create, and trash. False for the guest
  reviewer, so a guest sees a read-only outline and no management affordances.

The guest boundary is the one hard invariant: management is gated by `canManage`
and never reachable on the guest token route. An e2e test asserts a guest sees
no menu or management action.

## Forms without a full reload

`StoryOutline`'s management forms are plain POSTs today; on Write that means a
navigation, which is fine since Write is navigation-based. Review selection is
in-page, so a full-page POST would reset it. The management forms therefore use
`use:enhance` with `invalidateAll()` so a create/rename/delete refreshes the
data in place on both routes. This also smooths Write (no full reload to create
a scene), so it is a shared improvement, not Review-only special-casing.

## Sequencing

1. **Done.** `createChapter`/`createScene` lifted into `scene-lifecycle` so all
   scene/chapter management lives in one server module the Review route can also
   call. Covered by `scene-lifecycle` integration tests.

2. **Done.** Review route management actions: `sceneManageActions` (the shared
   factory) spread into the Review route with a review-page redirect base, and
   the trash list loaded for the sidebar. The Write route shares the same
   factory; behaviour there is unchanged.

3. **Done.** One outline component: `StoryOutline` gained the capability surface
   (`onSelectScene`, `sceneMeta`, `canManage`), `ReviewWorkspace` (author and
   guest) now renders it with a review-count badge and the row menu, and
   `ReviewNav` plus its `review.css` overrides are deleted. The author gets the
   right-click menu, inline rename, create, duplicate, merge, and trash; the
   guest gets a read-only outline (`canManage=false`). Verified with typecheck,
   lint, and the unit suite; a new `review-sidebar` e2e covers the author menu
   and the guest's read-only outline, alongside the Write sidebar e2e
   (`rename-sweep`, `scene-trash`, `scene-board`, `selection-menu`) as the
   regression backstop in CI.

4. **Done.** Scene drag-reorder in Review: the author's select-mode rows are
   draggable (gated by `canManage`, so the guest cannot), posting the new order
   the same way Write does. The author keeps the grab cursor, the guest a plain
   pointer.

5. **Done.** `use:enhance` on the create, rename, restore, move, and
   delete-to-trash forms, so neither route does a full reload; the row menu
   closes once the action lands. The two confirm-guarded forms (delete chapter,
   delete forever) keep the plain submit. On Review the selection is a writable
   derived of the URL's `?scene`, so a redirect lands back on the open scene
   while an in-page click overrides it.

Not visually verified in this environment (no browser; Playwright's matching
build is blocked by the egress allowlist). The e2e and a local visual pass are
the confirmation.
