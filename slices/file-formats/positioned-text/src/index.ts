/**
 * A PDF's text content as absolutely positioned runs — the neutral seam an
 * importer dialect parses from and the anonymizer downloads as shareable JSON —
 * and the service that extracts it from a PDF's bytes.
 *
 * @packageDocumentation
 */
export * as Document from './document.ts'
export * as Page from './page.ts'
export * as Run from './run.ts'
// Namespaced symbols are reached through their namespace above. The extractor
// module is not a namespace, so it exports flat.
export { PositionedTextExtractor, UnreadablePdf } from './positioned-text-extractor.ts'
