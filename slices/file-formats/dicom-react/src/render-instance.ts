/**
 * The cornerstone rendering seam: initialize once, register a DICOM file's
 * bytes, create a stack viewport in the supplied element, render, and keep the
 * canvas square with its box as that box changes.
 *
 * @remarks
 * All cornerstone imports are dynamic so the wasm codecs and vtk.js tree-shake
 * out of non-browser builds. A test injects a stub (jsdom has no WebGL).
 *
 * @packageDocumentation
 */

import type { Types } from '@cornerstonejs/core'

type RenderOutcome =
  | { readonly _tag: 'rendered' }
  | { readonly _tag: 'unrenderable'; readonly reason: string }

const rendered: RenderOutcome = { _tag: 'rendered' }
const unrenderable = (reason: string): RenderOutcome => ({ _tag: 'unrenderable', reason })

/**
 * The one rendering engine this module owns, and the one viewport inside it.
 *
 * @remarks
 * Both ids are constants rather than per-call values because cornerstone keys
 * a global cache on them. A fresh engine per call holds its own WebGL context,
 * and browsers cap those at around sixteen before they start dropping the
 * oldest — which surfaces as "WebGL context was lost" and a blank pane a few
 * previews in. Reusing one id means {@link https://www.cornerstonejs.org | cornerstone}
 * hands back the existing engine, and `enableElement` rebinds the viewport to
 * whatever element the current mount supplies (it disables a same-id viewport
 * itself before re-enabling).
 */
const RENDERING_ENGINE_ID = 'dicom-preview'
const VIEWPORT_ID = 'dicom-preview-viewport'

/**
 * The in-flight or settled initialization, so concurrent callers share one run.
 *
 * @remarks
 * A boolean flag does not work here: it can only be set *after* the awaits, so
 * two callers that start before the first finishes — React's StrictMode double
 * effect is exactly this — both see it unset and both initialize, and the
 * second `dicomImageLoaderInit` warns "Worker type 'dicomImageLoader' is
 * already registered". Memoizing the promise makes the second caller await the
 * first run instead of starting its own.
 */
let initialization: Promise<void> | null = null

/**
 * Run both library initializers once, in the order the cornerstone stack
 * tutorial prescribes.
 *
 * @remarks
 * The second call is the load-bearing one: `dicom-image-loader`'s `init`
 * is what runs `registerLoaders`, which registers the `wadouri:` scheme with
 * cornerstone core and spins up the frame-decoding worker. Without it
 * `setStack` gets an image id whose scheme no loader claims.
 *
 * `useLegacyMetadataProvider` picks *which* loader gets registered for the
 * `dicomfile:` scheme, and for a local file the default is the wrong one.
 * Without the flag the scheme resolves to `loadImageFromNaturalizedMetadata`,
 * which does not read the file — it asks a metadata provider to derive frames
 * from a naturalized dataset, and that provider only yields pixels when
 * `natural.PixelData` is a non-empty *array* alongside a `TransferSyntaxUID`.
 * A `fileManager.add(blob)` instance does not satisfy that, so the load
 * rejects with "no pixel data in NATURALIZED" after `setStack` has already
 * resolved — an unhandled rejection and a blank pane, with this function
 * having returned `rendered`. The flag restores the classic `loadImage`, which
 * parses the Part 10 bytes with `dicom-parser` and takes pixel data straight
 * off the dataset. It logs a deprecation warning; that is the price of the
 * only path that reads an actual file.
 */
async function runInitializers(): Promise<void> {
  const { init: coreInit } = await import('@cornerstonejs/core')
  const { init: dicomImageLoaderInit } = await import('@cornerstonejs/dicom-image-loader')
  await Promise.resolve(coreInit())
  await Promise.resolve(dicomImageLoaderInit({ useLegacyMetadataProvider: true }))
}

/** {@link runInitializers}, at most once — see {@link initialization}. */
function initCornerstone(): Promise<void> {
  // A failed run is forgotten rather than cached, so a later render retries
  // instead of replaying the same rejection forever.
  initialization ??= runInitializers().catch((error: unknown) => {
    initialization = null
    throw error
  })
  return initialization
}

/**
 * Render a DICOM instance's pixel data into `element` using cornerstone.
 *
 * @returns `rendered` on success, `unrenderable(reason)` when the file has no
 *   displayable pixel data or a codec is unavailable
 */
async function renderInstance(bytes: Uint8Array, element: HTMLDivElement): Promise<RenderOutcome> {
  try {
    await initCornerstone()

    const cornerstoneCore = await import('@cornerstonejs/core')
    const dicomImageLoader = await import('@cornerstonejs/dicom-image-loader')

    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/dicom' })
    const imageId = dicomImageLoader.wadouri.fileManager.add(blob)

    const renderingEngine =
      cornerstoneCore.getRenderingEngine(RENDERING_ENGINE_ID) ??
      new cornerstoneCore.RenderingEngine(RENDERING_ENGINE_ID)

    renderingEngine.enableElement({
      viewportId: VIEWPORT_ID,
      type: cornerstoneCore.Enums.ViewportType.STACK,
      element,
    })

    // TEMPORARY diagnostic — paired with the two below, this says which stage we
    // reached: no line at all means the effect never ran, `loading` with nothing
    // after it means the decode never settled, and `failed` names the error that
    // the catch otherwise hides inside the on-screen placeholder.
    console.info('[dicom-preview] loading', imageId)

    // Load before displaying, so a decode failure lands in this function's catch
    // and becomes an `unrenderable` the pane can show. `setStack` resolves once
    // the stack is *set*, not once the frame is decoded, so relying on it alone
    // reports `rendered` for an image that later fails — a blank pane and an
    // unhandled rejection in the console instead of a message on screen.
    await cornerstoneCore.imageLoader.loadAndCacheImage(imageId)

    const viewport = renderingEngine.getViewport<Types.IStackViewport>(VIEWPORT_ID)
    await viewport.setStack([imageId])
    viewport.render()

    // TEMPORARY diagnostic for the blank-preview investigation — remove once the
    // cause is pinned. Distinguishes "decoded but painted nothing" from "painted
    // into a zero-sized canvas".
    const imageData = viewport.getImageData()
    console.info('[dicom-preview] rendered', {
      elementSize: [element.clientWidth, element.clientHeight],
      canvasSize: [viewport.canvas?.width, viewport.canvas?.height],
      currentImageId: viewport.getCurrentImageId(),
      dimensions: imageData?.dimensions,
      scalarLength: imageData?.scalarData?.length,
      voiRange: viewport.getProperties().voiRange,
      cpuRendering: cornerstoneCore.getShouldUseCPURendering(),
    })

    return rendered
  } catch (error) {
    // TEMPORARY diagnostic — the returned reason only ever reaches the pane, so
    // without this a failure is invisible in the console.
    console.warn('[dicom-preview] failed', error)
    const reason = error instanceof Error ? error.message : String(error)
    return unrenderable(reason)
  }
}

/**
 * Keep the viewport's canvas backing store the same shape as the box it is
 * painted into, for as long as the returned disposer is uncalled.
 *
 * @remarks
 * Cornerstone sizes that backing store only at `enableElement` and never
 * re-reads the box, so without this the image is permanently stretched
 * whenever the two disagree. Why that is the normal case, and why the
 * arguments are `keepCamera: false`, is in the
 * {@link ../../docs/Cornerstone Rendering Explanation.md | Cornerstone Rendering Explanation}.
 *
 * @returns A disposer; calling it stops the observation.
 */
function observeViewportResize(element: HTMLDivElement): () => void {
  // jsdom has no ResizeObserver, so the component's tests exercise this call
  // and get an inert disposer rather than a crash.
  if (typeof ResizeObserver === 'undefined') return (): void => {}

  let observer: ResizeObserver | undefined = undefined
  let disposed = false

  void import('@cornerstonejs/core').then((cornerstoneCore) => {
    // The engine may not exist yet — this runs alongside `renderInstance`, not
    // after it — so it is looked up per callback rather than captured here.
    if (disposed) return
    observer = new ResizeObserver(() => {
      cornerstoneCore.getRenderingEngine(RENDERING_ENGINE_ID)?.resize(true, false)
    })
    observer.observe(element)
  })

  return (): void => {
    disposed = true
    observer?.disconnect()
  }
}

export type { RenderOutcome }
export { observeViewportResize, renderInstance }
