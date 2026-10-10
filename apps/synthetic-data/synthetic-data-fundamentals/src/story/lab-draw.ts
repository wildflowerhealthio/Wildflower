import type { StoryDay } from './story-day.ts'

/**
 * A base domain object of the story model: one lab result in a `Story`, the
 * value that drove, or answered, a medication change. A lab source's renderer
 * spells it as that source's report.
 *
 * @remarks
 * The story's record of what a lab reported, not a lab report: the lab
 * source's renderer decides how it is printed and coded.
 */
interface LabDraw {
  /** The day the specimen was collected. */
  readonly day: StoryDay
  /** The test as a lab report names it (`'INR'`, `'Hemoglobin A1c'`). */
  readonly test: string
  readonly value: number
  /** The unit as printed, or `null` for a unitless ratio such as the INR. */
  readonly unit: string | null
}

export type { LabDraw }
