/**
 * A medication's calendar-relevant fields: the next-fill instant and whether
 * a refill remains. The one input shape {@link deriveCalendarEvents} reads.
 *
 * `nextFillDate` is a **local** calendar day (`YYYY-MM-DD`) or `null` — the
 * caller reduces the source instant to the viewer's local day before passing
 * it here, a wall-clock / time-zone read this pure layer deliberately avoids.
 */
interface CalendarMedicationInput {
  readonly id: string
  readonly drugName: string
  readonly prescriber: string | null
  /**
   * Estimated next-fill date as a **local** calendar day (`YYYY-MM-DD`), or
   * `null` when unknown. See the module-level `@remarks` for how the caller
   * derives it.
   */
  readonly nextFillDate: string | null
  readonly hasRefill: boolean
}

export { type CalendarMedicationInput }
