/**
 * The browser extraction seam that turns a PDF's raw bytes into the neutral
 * positioned-text `Document` — via `pdfjs-dist`, behind a dynamic import — as
 * a function and as the `PositionedTextExtractor` layer.
 *
 * @packageDocumentation
 */
export { extractPositionedText } from './extract-pdf.ts'
export { positionedTextExtractorPdfjs } from './positioned-text-extractor-pdfjs.ts'
