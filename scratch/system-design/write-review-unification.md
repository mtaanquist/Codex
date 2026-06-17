# Write and Review unification

Status: proposed, 2026-06-17. Owner-driven from a design review of the Write
and Review screens. Nothing here is built yet; this is the plan of record for
the increments that follow.

## The problem

Write (`/stories/[id]`) and Review (`/stories/[id]/review`) look like the same
screen with different numbers in the sidebar, but underneath they are two
separate stacks sharing only the shell (TopBar, the Write/Plan/Notes/Review
mode strip, the three-pane layout, most of the CSS):

- The centre is two different editors: `SceneEditor` (full CodeMirror, mentions,
  autocomplete, split/merge, whole-story view, preview, revision history) on
  Write; `ReviewEditor` / `ReviewSurface` (comment marks, suggestion
  decorations, accept/reject) on Review.
- The left sidebar is two components: `StoryOutline` (book switcher, drag to
  reorder, right-click row menu, inline rename, create, trash, word counts) and
  `ReviewNav` (a reduced reimplementation: collapse and select only, with
  review-count badges).
- The right column differs: Reference / History / Session / Assistant on Write;
  the thread/composer `ReviewPanel` on Review.

Three concrete pains fall out of this split:

1. Moving between Write and Review is a full route navigation. The editor
   remounts, scroll and caret are lost, the whole UI jumps.
2. While reviewing, the author loses the manuscript-management toolkit (no
   split, merge, reorder, rename, right-click menu). They cannot act on the
   structural problems a review surfaces without leaving review.
3. The two sidebars drift in feel. The base row CSS is shared (one definition
   in `theme.css`), so the drift is not visual; it is behavioural. `ReviewNav`
   rows are `<button>` not `<a>`, there is no right-click menu, no drag, no word
   counts. The review sidebar reads as the less finished half.

## Why ReviewNav cannot simply gain the menu

The row menu (`StoryRowMenu`) posts to **route-local form actions**:
`?/moveChapter`, `?/deleteChapter`, `?/deleteScene`, `?/renameChapter`, and the
inline create/rename forms in `StoryOutline` post to `?/createScene`,
`?/createChapter`, `?/restoreScene`, `?/destroyScene`. The Review route's
`+page.server.ts` has none of these; it has only review-thread actions
(`comment`, `suggest`, `reply`, `resolve`, `acceptSuggestion`, ...). So the
sidebar divergence is not laziness. The actions the menu needs do not exist on
that route, and duplicating eight form actions onto a second route would be the
wrong fix.

## The decision

Do not duplicate the action surface. Unify the surface: Write and Review become
one authoring surface where Review is a layer the author toggles on, not a
separate route. One route means one set of form actions, one outline, one
selection model, and one right column that swaps its contents by mode. The
outline unification, and the right-click menu in review, then fall out for free
rather than being ported.

This is a layer below the UI control that triggers it. Whether the toggle lives
on the Write/Plan/Notes/Review strip or in the toolbar is a secondary UI
decision (see Open questions); the architecture is the same either way.

### What stays separate: the guest reviewer

`/review/[token]` is an account-less, write-access-less surface that mounts
`ReviewWorkspace` with `role="guest"` and the read-only `ReviewSurface`. The
design forbids guests any write access to prose (design.md: "guest-review role
... without that guest gaining an account or write access to the prose"). So
Review as a concept does not disappear:

- The author gets the unified surface (write + review in one place).
- The guest keeps a review-only surface: read, comment, suggest. No editor, no
  sidebar management, no Reference/History/Session/Assistant, no universe nav.

The risk to avoid is two implementations of comment/suggestion rendering. The
guest surface and the author's review layer must share the same primitives
(marks, suggestion cards, the margin rail), differing only in capability, not in
code. A `canManage` / `role` flag gates the management affordances off for
guests; it never gates them in via a second code path.

### Selection model convergence

The reason an outline row is an `<a href>` on Write and a `<button onclick>` on
Review is that Write selection rides the URL (each scene is a separate route
load that remounts `SceneEditor`) while Review swaps an in-memory
`chosenSceneId` with no navigation. Once the surface is one route, selection
converges to one model and the row is one element in both. This is the change
that makes the outline genuinely one component instead of one component with a
link/button fork.

## Sequencing

Each step is shippable on its own and leaves the app working.

1. **Shared management logic, route-agnostic.** Lift the scene/chapter
   management operations out of the Write route's form-action bodies into a
   shared server module so the logic has a single home regardless of how many
   routes call it. Covered by the existing integration tests
   (`scene-lifecycle`, `scene-order`, `scene-status`). No UI change.

2. **One outline component.** Grow `StoryOutline` to take a capability config
   (`canManage`, a trailing-badge slot for word count vs review count, an
   optional `onSelect` vs href, optional drag, optional row menu). Switch
   `ReviewWorkspace` (author and guest) onto it; delete `ReviewNav`. Guests run
   with `canManage=false` so no menu, drag, or create appears. The right-click
   menu lights up on the author review side as the actions become reachable.

3. **One surface.** Make Review an in-place mode of the writing surface: the
   centre swaps `SceneEditor` for the review editor (or `SceneEditor` grows a
   review layer), the right column swaps to the review panel, and the URL
   carries the mode (`?mode=review`) so links and the back button survive. No
   remount on toggle. The author can split/merge/reorder while reviewing.

4. **Right column declutter + margin-rail minimap.** With review living on the
   main surface, move comment navigation into the right gutter: extend
   `ReviewMarginRail` into a minimap for jumping between comments, and thin the
   right panel. Independent of the merge; can land alongside or after.

5. **Guest surface on shared primitives.** Reconcile the guest review page to
   reuse the same review rendering as the author layer, read-only.

## Risks and watch-items

- **Guest boundary.** The highest-stakes invariant. Every management affordance
  must be gated by capability, verified by an e2e test that a guest token sees
  no editor, menu, or management action.
- **Right-column state.** One column now hosts two tab sets. Keep the mode the
  single source of truth for what it shows.
- **Load cost.** The merged surface should lazy-load review data (threads,
  suggestions) on first toggle rather than eagerly for every writing session.
- **Mobile.** `ReviewWorkspace` has a bespoke Scenes/Manuscript/Notes tab
  layout (tablet review is a v1 target; mobile authoring is not). The merged
  surface must keep a working review layout at tablet width.
- **Destructive actions mid-review.** Deleting or merging a scene that has open
  threads or pending suggestions needs a defined outcome. Threads anchor to
  scenes, so deletion should cascade as today, but the unified menu must answer
  this where the Write menu never had to.

## Open questions

- **Toggle placement.** Keep Review on the Write/Plan/Notes/Review strip (same
  axis as Plan and Notes, better for discoverability) versus the prose-view
  menu (Edit/Preview/Focus/Print). The strip is preferred: Review is "what I am
  doing with the manuscript", not "how I am viewing this scene". Resolve before
  step 3.
- **Editor: layer vs swap.** Does `SceneEditor` grow a review layer (marks +
  suggestions as optional decorations) or does the surface swap to a distinct
  review editor on toggle? A layer is the bigger simplification but the larger
  CodeMirror change. Decide at step 3.
