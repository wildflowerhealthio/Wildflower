/**
 * The codes of `WildflowerCodeSystem.ExerciseParameter`: which parameter of
 * an exercise an exercise `ServiceRequest.orderDetail` or an exercise
 * definition's `PlanDefinition.action.code` concept gives. Each such concept
 * carries its value in a `WildflowerExtension.ExerciseParameterValue`
 * extension.
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
type Code = (typeof Code)[keyof typeof Code]

export { Code }
