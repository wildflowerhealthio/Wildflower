import { Schema } from 'effect'

/**
 * One span of extracted text, positioned on the page.
 *
 * @remarks
 * Coordinates use a top-left origin: `x` and `y` are the top-left corner of
 * the run's bounding box. Every measure is finite, because JSON has no `NaN`
 * or `Infinity` and `Document.FromJson` would otherwise write one as `null`.
 */
const RunSchema = Schema.Struct({
  text: Schema.String,
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  fontSize: Schema.Finite,
  fontName: Schema.optional(Schema.String),
})

type RunType = typeof RunSchema.Type

/**
 * Transform a run's text, keeping its position and font. Returns a new run with
 * the mapped text.
 */
const mapText = (run: RunType, f: (text: string) => string): RunType => {
  const text = f(run.text)
  return text === run.text ? run : { ...run, text }
}

export { RunSchema as Schema, mapText }
export type { RunType as Type }
