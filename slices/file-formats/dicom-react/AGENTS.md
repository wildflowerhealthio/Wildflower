# AGENTS.md — slices/file-formats/dicom-react

Browser-side DICOM rendering: the `DicomArchivePreview` component (identifying
patient and study tags beside a cornerstone-rendered image pane) and the
`renderInstance` seam that drives cornerstone initialization and viewport
rendering. Sits alongside the pure `dicom` parser, adding the React +
cornerstone browser adapter.

## Shape

- `src/archive-preview.tsx` — `DicomArchivePreview`: parses the file with
  `parseDicomFile` from `dicom` and renders patient/study tags in two blocks
  beside an image pane. A parse failure renders an inline error; an
  unrenderable instance (no pixel data, codec failure) shows a placeholder.
  The `renderDicomInstance` prop defaults to the real `renderInstance` but is
  injectable for testing under jsdom (no WebGL). Missing tags display as an
  em-dash.
- `src/render-instance.ts` — `renderInstance`: the cornerstone rendering seam.
  Initializes cornerstone once (lazy, idempotent), registers DICOM bytes via
  `@cornerstonejs/dicom-image-loader`'s file manager, creates a stack viewport,
  and renders. Returns a `RenderOutcome` tagged union (`rendered` |
  `unrenderable(reason)`). All cornerstone imports are dynamic so the wasm
  codecs tree-shake out of non-browser builds.
- `src/index.ts` — public API barrel.

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
