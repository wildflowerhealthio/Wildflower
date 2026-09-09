import { Schema } from 'effect'

/**
 * One span of extracted text, positioned on the page.
 *
 * @remarks
 * Coordinates use a top-left origin: `x` and `y` are the top-left corner of
 * the run's bounding box, matching the coordinate system pdfjs-dist reports.
 */
const PositionedTextRun = Schema.Struct({
  text: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  fontSize: Schema.Number,
  fontName: Schema.optional(Schema.String),
})

type PositionedTextRun = typeof PositionedTextRun.Type

/**
 * One page of extracted positioned text.
 */
const PositionedTextPage = Schema.Struct({
  pageNumber: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  runs: Schema.Array(PositionedTextRun),
})

type PositionedTextPage = typeof PositionedTextPage.Type

/**
 * A PDF's text content as absolutely positioned runs — the neutral seam the
 * importer pipeline's future LifeLabs dialect parses from, and the format the
 * anonymizer downloads as shareable JSON.
 */
const PositionedTextDocument = Schema.Struct({
  format: Schema.Literal('wildflower-positioned-text'),
  version: Schema.Literal(1),
  fileName: Schema.optional(Schema.String),
  pages: Schema.Array(PositionedTextPage),
})

type PositionedTextDocument = typeof PositionedTextDocument.Type

const PositionedTextFromJson = Schema.parseJson(PositionedTextDocument)

export { PositionedTextDocument, PositionedTextFromJson, PositionedTextPage, PositionedTextRun }
