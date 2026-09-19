/**
 * The cornerstone rendering seam: initialize once, register a DICOM file's
 * bytes, create a stack viewport in the supplied element, and render.
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

let initialized = false

async function initCornerstone(): Promise<void> {
  if (initialized) return
  const { init } = await import('@cornerstonejs/core')
  await Promise.resolve(init())
  initialized = true
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

    const renderingEngineId = `dicom-preview-${Date.now()}`
    const viewportId = 'dicom-preview-viewport'

    const renderingEngine = new cornerstoneCore.RenderingEngine(renderingEngineId)

    renderingEngine.enableElement({
      viewportId,
      type: cornerstoneCore.Enums.ViewportType.STACK,
      element,
    })

    const viewport = renderingEngine.getViewport<Types.IStackViewport>(viewportId)
    await viewport.setStack([imageId])
    viewport.render()

    return rendered
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return unrenderable(reason)
  }
}

export type { RenderOutcome }
export { renderInstance }
