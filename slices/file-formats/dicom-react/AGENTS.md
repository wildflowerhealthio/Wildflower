# AGENTS.md — slices/file-formats/dicom-react

Browser-side DICOM rendering: the `DicomArchivePreview` component (identifying
patient and study tags, plus how the instance is encoded, beside a
cornerstone-rendered image pane) and the `renderInstance` seam that drives
cornerstone initialization and viewport rendering. Sits alongside the pure
`dicom` parser, adding the React + cornerstone browser adapter.

## Shape

- `src/archive-preview.tsx` — `DicomArchivePreview`: parses the file with
  `parseDicomFile` from `dicom` and renders Patient, Study and Encoding tag
  blocks beside an image pane. A parse failure renders an inline error; an
  unrenderable instance (no pixel data, codec failure) shows a placeholder.
  The `renderDicomInstance` prop defaults to the real `renderInstance` but is
  injectable for testing under jsdom (no WebGL). Missing tags display as an
  em-dash.
- `src/encoding-rows.ts` — `encodingRows`: the Encoding block's rows (transfer
  syntax and SOP class with their names, pixel layout, bit depth, rescale and
  windowing, the Pixel Data element, parser warnings), formatted from a
  `DicomHeader`. Pure and React-free, so the formatting is tested without a
  DOM.

  The block exists because a blank image pane says nothing about **why**. Two
  conventions carry that weight and are worth keeping. Every row is emitted
  even when its tag is absent — a row that vanishes reads as "not checked"
  rather than "not present". And an absent Pixel Data element gets a sentence
  rather than an em-dash, because "this instance carries no image" (a
  Structured Report, a Presentation State) is the most common answer and the
  one an em-dash would hide. Renderer-side facts — what cornerstone decoded,
  the canvas size, the CPU-rendering flag — are deliberately _not_ here; they
  stay in `renderInstance`'s console diagnostics.

- `src/render-instance.ts` — `renderInstance`: the cornerstone rendering seam.
  Initializes cornerstone once (lazy, idempotent), registers DICOM bytes via
  `@cornerstonejs/dicom-image-loader`'s file manager, binds a stack viewport,
  and renders. Returns a `RenderOutcome` tagged union (`rendered` |
  `unrenderable(reason)`). All cornerstone imports are dynamic so the wasm
  codecs tree-shake out of non-browser builds.

  Two details are load-bearing and easy to regress. **Both** initializers run —
  core's _and_ the image loader's, the latter being what registers the
  `wadouri:` scheme — and the initialization is memoized as a _promise_, not a
  boolean, so StrictMode's double effect shares one run instead of registering
  the decode worker twice. The rendering engine and viewport use **constant
  ids**, so every render reuses one engine rather than leaking a WebGL context
  per call; `enableElement` rebinds the shared viewport to the current mount's
  element on its own.

  Same file, second seam: **`observeViewportResize`**, which the component runs
  for the life of a mount and disposes on unmount. Without it cornerstone's
  canvas keeps the backing store it was given at `enableElement` and the image
  stretches — see the [Cornerstone Rendering Explanation](../docs/Cornerstone%20Rendering%20Explanation.md).

- `src/index.ts` — public API barrel.

## Build requirements for the host app

The renderer needs two things from the app that bundles it, both set in
[`apps/importer-web/vite.config.ts`](../../../apps/importer-web/vite.config.ts):
an `events` shim aliased in, or `@cornerstonejs/core` fails to evaluate at all;
and `@cornerstonejs/dicom-image-loader` excluded from `optimizeDeps`, or its
decode worker and WASM codec URLs are rewritten to paths that do not exist.

The second fails in a way that reads as missing codec support rather than a
build problem — "some DICOM files render and some do not, split by transfer
syntax" is this. The
[Cornerstone Rendering Explanation](../docs/Cornerstone%20Rendering%20Explanation.md)
has the dispatch table that causes it and how to tell the two apart.

## Layering

- **Depends on**: `dicom` (tag parser), `@cornerstonejs/core` and
  `@cornerstonejs/dicom-image-loader` (image rendering), `effect` (`Either`),
  `react`.
- **Depended on by**: `dicom-importer-react` (re-exports
  `DicomArchivePreview`), `importer-react` (via `dicom-importer-react`).

## References

- [file-formats AGENTS.md](../AGENTS.md) — the slice this package belongs to
- [dicom-importer-react AGENTS.md](../../importer/dicom-importer-react/AGENTS.md) —
  the re-export consumer
