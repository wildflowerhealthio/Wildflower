import { Schema } from 'effect'

import * as Page from './page.ts'
import type * as Run from './run.ts'

/**
 * A PDF's text content as absolutely positioned runs — the neutral seam the
 * importer pipeline's future LifeLabs dialect parses from, and the format the
 * anonymizer downloads as shareable JSON.
 */
const DocumentSchema = Schema.Struct({
  format: Schema.Literal('wildflower-positioned-text'),
  version: Schema.Literal(1),
  fileName: Schema.optional(Schema.String),
  pages: Schema.Array(Page.Schema),
})

type DocumentType = typeof DocumentSchema.Type

const FromJson = Schema.parseJson(DocumentSchema)

/**
 * Transform the text of every run in the document, keeping page geometry and
 * each run's position and font. Returns a new document.
 */
const mapText = (document: DocumentType, f: (text: string) => string): DocumentType => ({
  ...document,
  pages: document.pages.map((page) => Page.mapText(page, f)),
})

/**
 * Every run in the document, in page then run order — the document's runs
 * flattened across pages.
 */
const runs = (document: DocumentType): readonly Run.Type[] =>
  document.pages.flatMap((page) => page.runs)

export { DocumentSchema as Schema, FromJson, mapText, runs }
export type { DocumentType as Type }
