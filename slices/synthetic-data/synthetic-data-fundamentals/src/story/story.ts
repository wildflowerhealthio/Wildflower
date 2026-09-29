import type { LabDraw } from './lab-draw.ts'
import type { Person } from './person.ts'
import type { Prescription } from './prescription.ts'

/**
 * The root of the story model: one person's dated record, which a renderer
 * reads to write that person's files for a source. It holds who they are, what
 * they were prescribed and filled, and the lab results their dose changes
 * answer to. Every date is a `StoryDay`, relative to the as-of date.
 */
interface Story {
  readonly person: Person
  /** In the order each was written. */
  readonly prescriptions: readonly Prescription[]
  /** In collection order. */
  readonly labDraws: readonly LabDraw[]
}

export type { Story }
