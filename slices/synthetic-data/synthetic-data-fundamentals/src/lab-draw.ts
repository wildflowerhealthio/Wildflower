import type { StoryDay } from './story-day.ts'

/**
 * One lab result in a story: the value that drove, or answered, a medication
 * change.
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
