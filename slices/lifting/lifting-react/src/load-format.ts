/** Pounds with up to two decimals — enough for 1.25 lb micro-plates — and no trailing zeros. */
const loadFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/**
 * A load as a person reads it, e.g. `"47.5 lb"`.
 *
 * @param loadLb - The load in pounds
 */
const formatLoadLb = (loadLb: number): string => `${loadFormat.format(loadLb)} lb`

/**
 * Reps completed per set as a compact run, e.g. `"5/5/5/4/3"`; a dash when no
 * set was performed.
 *
 * @param repsCompleted - Reps completed, one entry per set performed
 */
const formatRepsCompleted = (repsCompleted: readonly number[]): string =>
  repsCompleted.length === 0 ? '–' : repsCompleted.join('/')

export { formatLoadLb, formatRepsCompleted }
