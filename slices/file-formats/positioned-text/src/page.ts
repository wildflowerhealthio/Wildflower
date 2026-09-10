import { Schema } from 'effect'

import * as Run from './run.ts'

/**
 * One page of extracted positioned text.
 */
const PageSchema = Schema.Struct({
  pageNumber: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  runs: Schema.Array(Run.Schema),
})

type PageType = typeof PageSchema.Type

/**
 * Transform the text of every run on the page, keeping page geometry and each
 * run's position and font. Returns a new page.
 */
const mapText = (page: PageType, f: (text: string) => string): PageType => ({
  ...page,
  runs: page.runs.map((run) => Run.mapText(run, f)),
})

export { PageSchema as Schema, mapText }
export type { PageType as Type }
