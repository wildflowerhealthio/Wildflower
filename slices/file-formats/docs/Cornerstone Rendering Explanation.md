# Cornerstone Rendering Explanation

Why `dicom-react`'s image pane behaves the way it does, and what a host app has
to configure before it works at all. Three things about
[cornerstone](https://www.cornerstonejs.org) surprised us enough to cost real
debugging time; each is cheap to re-break, and none of them fails in a way that
points at its cause.

## One transfer syntax decodes on the main thread; the rest do not

`decodeImageFrame` in `@cornerstonejs/dicom-image-loader` special-cases exactly
one entry in its dispatch table:

```js
case '1.2.840.10008.1.2.4.50':
  if (imageFrame.bitsAllocated === 8 &&
      (imageFrame.samplesPerPixel === 3 || imageFrame.samplesPerPixel === 4)) {
    return decodeJPEGBaseline8BitColor(imageFrame, pixelData, canvas)
  }
  return processDecodeTask(...)
```

`decodeJPEGBaseline8BitColor` builds a `Blob` and hands it to `new Image()` —
the **browser's own** JPEG decoder, on the main thread, touching neither the
decode worker nor any WASM codec. Every other transfer syntax, including plain
uncompressed and RLE, goes to `processDecodeTask` and therefore to the worker.

The consequence is a misleading symptom. When the worker or the codecs are
unavailable, JPEG Baseline 8-bit colour files render perfectly and everything
else fails, which reads as "cornerstone has no codec for my files" rather than
as a build problem. A file rendering proves nothing about the decode
infrastructure unless it is a syntax that uses it.

Useful discriminator when triaging: RLE and the uncompressed syntaxes need the
worker but no WASM. Whether _those_ render separates a broken worker from
broken codec URLs.

## The worker and codec URLs break under Vite's dep pre-bundling

The loader finds its worker and its four WASM codecs with
`new URL(..., import.meta.url)`. Vite's dependency pre-bundler flattens the
whole package into one chunk under `node_modules/.vite/deps/`, which moves
`import.meta.url` and rewrites both kinds of URL to paths that do not exist.
The codec ones are the most visible:

```js
// what the optimized chunk contains
new URL('.../dist/esm/shared/decoders/@cornerstonejs/codec-openjpeg/decodewasm', import.meta.url)
```

— a bare package specifier resolved as if it were a relative path.

A host app therefore has to exclude the loader from `optimizeDeps` and set
`worker: { format: 'es' }`, and then name back in the CommonJS dependencies
reached _through_ it: `dicom-parser` and the four codec factories. Excluding a
package stops its dependencies being converted, and a raw CJS module has no
`default` export for the loader's `import codecFactory from '…'` to bind. That
error is thrown while the loader's module graph evaluates, so it takes down
every decode path at once — including the main-thread one above, which needs no
codec.

[`apps/importer-web/vite.config.ts`](../../../apps/importer-web/vite.config.ts)
carries the working configuration.

Only the dev server is affected. The production build resolves both kinds of
URL correctly and emits the worker chunk plus all four `.wasm` files.

## The canvas is sized once, so the image stretches

`getOrCreateCanvas` gives cornerstone's canvas `width: 100%; height: 100%` and
sets the backing store **once**, from the element's box at `enableElement`
time. The browser rescales that fixed backing store into the CSS box on every
paint, so the moment the box's aspect ratio stops matching the backing store's,
the image is stretched along one axis — permanently, because nothing re-reads
the box.

Two things make that the normal case rather than an edge case. The image pane
is a flex child whose height comes from the tag column beside it, so its box
changes shape whenever the window does. And `getOrCreateCanvas` skips sizing
altogether for a zero-sized element, leaving the canvas at its default
300 × 150 — which is what a preview mounted before layout settles gets, and why
a first frame can arrive stretched with no resize at all.

`renderingEngine.resize(immediate, keepCamera)` re-reads the box, resizes the
backing store and refits the image; `dicom-react`'s `observeViewportResize`
drives it from a `ResizeObserver`. Two details matter:

- **`keepCamera: false`** for a non-interactive preview. `resize` always runs
  `resetViewStateForResize`; `keepCamera: true` then restores the camera framed
  for the _old_ box on top of it.
- A `ResizeObserver` delivers one callback when it **starts** observing, which
  is what repairs the degenerate first frame. So observation starts alongside
  the render rather than after it — waiting for a multi-megabyte decode would
  leave that frame stretched until the next resize.

Cornerstone no-ops when the displayed and backing sizes already agree, so the
observer is cheap to leave running.

## See Also

- [dicom-react AGENTS.md](../dicom-react/AGENTS.md) — the package these notes
  describe
- [Learnings Inbox](../../../docs/Agents/Learnings%20Inbox.md) — where these
  started
