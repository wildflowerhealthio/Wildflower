/** The comparators FHIR's `Quantity.comparator` admits. */
type Comparator = '<' | '<=' | '>=' | '>'

/**
 * A printed result read as the FHIR value it becomes: a number (with the
 * comparator a censored result carries — `<0.1`) or, for anything else
 * (`NEGATIVE`, `NOT DETECTED`, `YELLOW`, a date, a time), the printed text.
 */
type ResultValue =
  | {
      readonly _tag: 'quantity'
      readonly value: number
      readonly comparator: Comparator | undefined
    }
  | { readonly _tag: 'text'; readonly text: string }

/** `8.0`, `-2`, `<0.1`, `>= 60`, `1,234` (a thousands separator). */
const NUMERIC = /^(<=|>=|<|>)?\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)$/

const isComparator = (text: string): text is Comparator =>
  text === '<' || text === '<=' || text === '>=' || text === '>'

/**
 * Read a printed `Result` cell.
 *
 * @param text - The `Result` column as printed
 * @returns A `quantity` when the text is a number with at most a leading
 *   comparator, otherwise the trimmed text
 */
const parseResultValue = (text: string): ResultValue => {
  const trimmed = text.trim()
  const match = NUMERIC.exec(trimmed)
  if (match === null) return { _tag: 'text', text: trimmed }
  const [, comparatorText, numberText = ''] = match
  // `-0` prints as `-0` but means zero; keep the sign out of the quantity.
  const value = Number(numberText.replaceAll(',', '')) || 0
  return {
    _tag: 'quantity',
    value,
    comparator:
      comparatorText !== undefined && isComparator(comparatorText) ? comparatorText : undefined,
  }
}

export { parseResultValue }
export type { Comparator, ResultValue }
