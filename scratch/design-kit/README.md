# Design kit

Preview cards for the Codex design system, built for syncing into a Claude
Design (claude.ai/design) design-system project so design sessions work from
the real system instead of a description.

Each `*.html` file is one card: a self-contained page that renders a
canonical primitive in all three themes (dark, light, warm) side by side,
using the real CSS. The first line of each file is a `@dsCard` marker with
the card's group; the Design System pane uses it to build its index.

## Ground rules

- `styles/` is a symlink to `src/lib/styles/`. The kit has no CSS of its
  own beyond per-card scaffolding; the shipped stylesheets are the single
  source of truth, and the cards always render whatever is currently
  shipped.
- Cards show only the canonical primitives named in
  `scratch/system-design/design-system.md`. Legacy skins (the extra button
  and menu systems listed in that sheet's drift section) stay out, so
  design sessions never learn them.
- Markup in the cards mirrors real call sites in `src/lib/components/` and
  `src/routes/`. When a primitive's markup changes in the app, update its
  card.
- Fonts: `fonts.css` bundles the real families (Hanken Grotesk, Spectral,
  JetBrains Mono; latin subsets, SIL OFL) copied from the same fontsource
  packages the app loads, so previews use the actual letterforms. When the
  app's font versions change, re-copy the woff2 files from
  `node_modules` into `fonts/`.

## Viewing locally

Open any card straight from this directory in a browser; the symlink makes
the shipped CSS resolve. No build step.

## Syncing to Claude Design

Use the DesignSync tool from a Claude Code session (it needs the user
present to approve the plan):

1. `list_projects`, or `create_project` the first time.
2. `finalize_plan` with writes for `styles/*.css`, `*.html`, `kit.css`,
   `kit.js`, `fonts.css`, and `fonts/*.woff2`. Use the repository root as
   `localDir`: the tool refuses to read through the `styles/` symlink
   (it resolves outside this directory), so the stylesheets upload from
   `src/lib/styles/` directly.
3. `write_files` uploading the stylesheets into the project's `styles/`,
   and the cards, scaffold, and font files at their kit-relative paths.

Re-run the sync whenever a primitive or token changes. The sync is one-way,
repo to project; never edit the system inside the project.

## Cards

Foundations: `colors.html`, `type.html`, `spacing.html`.
Components: `buttons.html`, `forms.html`, `menus.html`, `badges.html`,
`seg.html`, `cards.html`, `empty-states.html`, `modal.html`.
