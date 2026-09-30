/**
 * The codes of `WildflowerCodeSystem.LiftingMeasure`: what an exercise
 * `ServiceRequest.orderDetail` or a planned exercise's
 * `PlanDefinition.action.code` concept measures. Each such concept carries
 * its value in a `WildflowerExtension.LiftingMeasureValue` extension.
 *
 * @remarks
 * Persisted wire format, like the system url itself — a code written here is
 * only found again by the same code, so treat this as append-mostly.
 */
const Code = {
  /** A load, as a UCUM `valueQuantity` (`[lb_av]` or `kg`). */
  Load: 'load',
  /** Sets per workout, as a `valueInteger`. */
  Sets: 'sets',
  /** Reps per set, as a `valueInteger`. */
  Reps: 'reps',
} as const

/** One of the {@link Code} codes. */
type Measure = (typeof Code)[keyof typeof Code]

export { Code }
export type { Measure }
