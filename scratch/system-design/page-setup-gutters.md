# Page setup: gutters / binding margins

Status: feasibility verified by spike. No code yet.

## The ask

Print books bind on the spine, so the **inner** margin (next to the spine) needs to be
larger than the outer margin, and which side is "inner" alternates: left margin on
right-hand (recto) pages, right margin on left-hand (verso) pages. This is a real need for
anyone taking the PDF to a print-on-demand service - and the app already offers trade page
sizes (5x8, 5.5x8.5, 6x9), so it is squarely in scope for novelists.

It is a **print/PDF-only** concept. EPUB reflows and the on-screen reader has no spine, so
they are unaffected.

## Is it possible with how we render? Yes - verified.

CSS Paged Media expresses it with `@page :left` / `@page :right` (mirrored margins). The
open question was whether headless Chromium - the engine the worker's PDF path uses -
actually honors *different* margins on `:left` vs `:right` in PDF output (its support has
historically been patchy).

A spike rendered a 6x9 PDF with mirrored margins (inner 2in, outer 0.5in) through Chromium
and measured the left text edge per page with pdfjs:

- Mirrored: `150, 42, 150, 42, ...` pts - alternates exactly (~2in recto, ~0.5in verso).
- Symmetric control (`@page { margin: 1in }`): uniform `78` pts on every page.

So Chromium honors mirrored `@page` margins. Gutters are achievable.

## What changes

### Data model (small, additive)

Add a `gutter` to `PageSetup` (e.g. a `'none' | 'narrow' | 'wide'` enum, or a length).
Effective margins become: outer = `margins`, inner = `margins + gutter`. Default `none`
keeps today's symmetric output, so nothing changes for single-sided/EPUB users.

### `pageCss()` (src/lib/page-setup.ts)

Today it emits one `@page { margin: <single> }`. With a gutter it emits:

```css
@page :right { margin-top: T; margin-bottom: B; margin-left: INNER; margin-right: OUTER; }
@page :left  { margin-top: T; margin-bottom: B; margin-left: OUTER; margin-right: INNER; }
```

(When gutter is none, keep the single `@page` rule.)

### Browser print route

Already drives margins through CSS `@page`, so it picks up the `:left/:right` rules with
no special handling.

### Worker PDF - the one wrinkle

The PDF path currently sets margins through Chromium's `page.pdf({ margin })` option (a
single uniform box) and deliberately *omits* the `@page` rule. The margin option has no
left/right-page concept, so gutters require switching the PDF to **CSS-driven margins**:
include the `@page :left/:right` rule (i.e. `pageCss(setup, { includePageRule: true })`),
set `preferCSSPageSize: true`, and drop the uniform `margin` option.

The catch: page numbers and the running header are drawn by Chromium's
`displayHeaderFooter` layer, which today reserves its space using the *option* margins.
Moving margins into CSS needs that reconciled so the header/footer still has room and does
not overlap the text. This is the remaining thing to validate before shipping (a second
spike: mirrored CSS margins + `displayHeaderFooter` on, confirm the page number lands in
the bottom margin on both page sides). Options if it fights: keep top/bottom in the pdf
option and put only the left/right gutter in CSS, or render page numbers via a CSS
margin box instead of the Chromium layer.

### Settings UI

Add a "Binding / gutter" control to the two page-setup forms (story settings + account
default), shown alongside margins. Worth a one-line hint that it only affects PDF/print.

## Scope summary

- Affects: PDF export, browser print.
- Not affected: EPUB (reflows), on-screen reader, the editor.
- Effort: small data + `pageCss` change; the real work is the PDF header/footer
  reconciliation. De-risked by the verified `@page :left/:right` support above.
