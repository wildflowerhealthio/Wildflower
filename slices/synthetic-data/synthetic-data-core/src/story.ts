import type { LabDraw } from './lab-draw.ts'
import type { Person } from './person.ts'
import type { Prescription } from './prescription.ts'

/**
 * One person's dated record: who they are, what they were prescribed and
 * filled, and the lab results their dose changes answer to. Every date is a
 * `StoryDay`, relative to the as-of date.
 */
interface Story {
  readonly person: Person
  /** In the order each was written. */
  readonly prescriptions: readonly Prescription[]
  /** In collection order. */
  readonly labDraws: readonly LabDraw[]
}

export type { Story }
