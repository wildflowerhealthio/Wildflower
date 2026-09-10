import { Schema } from 'effect'

/**
 * One span of extracted text, positioned on the page.
 *
 * @remarks
 * Coordinates use a top-left origin: `x` and `y` are the top-left corner of
 * the run's bounding box, matching the coordinate system pdfjs-dist reports.
 */
const RunSchema = Schema.Struct({
  text: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  fontSize: Schema.Number,
  fontName: Schema.optional(Schema.String),
})

type RunType = typeof RunSchema.Type

/**
 * Transform a run's text, keeping its position and font. Returns a new run with
 * the mapped text.
 */
const mapText = (run: RunType, f: (text: string) => string): RunType => ({
  ...run,
  text: f(run.text),
})

export { RunSchema as Schema, mapText }
export type { RunType as Type }
