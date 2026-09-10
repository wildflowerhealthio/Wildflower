import type { Document, Page, Run } from 'positioned-text'

/**
 * Extract positioned text from a PDF's raw bytes via pdfjs-dist.
 *
 * @remarks
 * The dynamic `import('pdfjs-dist')` keeps the 2 MB library out of the
 * critical path and lets the seam stay untested — everything downstream is
 * tested against hand-written fixture documents. The worker is configured via
 * `GlobalWorkerOptions.workerSrc` with an `import.meta.url`-relative path so
 * vite emits the worker asset alongside the bundle.
 */
const extractPositionedText = async (
  bytes: Uint8Array,
  fileName?: string
): Promise<Document.Type> => {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).href

  const pdf = await pdfjs.getDocument({ data: bytes }).promise
  const pages: Page.Type[] = []

  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()

    const runs: Run.Type[] = []
    for (const item of content.items) {
      if (!('str' in item) || item.str === '') continue
      const tx = item.transform
      runs.push({
        text: item.str,
        x: Number(tx[4]),
        y: viewport.height - Number(tx[5]) - item.height,
        width: item.width,
        fontSize: item.height,
        ...('fontName' in item && typeof item.fontName === 'string' && item.fontName !== ''
          ? { fontName: item.fontName }
          : {}),
      })
    }

    pages.push({
      pageNumber: i,
      width: viewport.width,
      height: viewport.height,
      runs,
    })
  }

  return {
    format: 'wildflower-positioned-text',
    version: 1,
    ...(fileName !== undefined ? { fileName } : {}),
    pages,
  }
}

export { extractPositionedText }
