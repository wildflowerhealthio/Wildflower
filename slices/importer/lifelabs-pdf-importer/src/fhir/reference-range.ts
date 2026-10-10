/**
 * A printed reference range read into bounds, or kept as text when it has
 * none (`See below`, `NEGATIVE`, `NONE/YELLOW`).
 */
interface ReferenceRange {
  readonly low: number | undefined
  readonly high: number | undefined
  /** The range exactly as printed — always kept, bounds or not. */
  readonly text: string
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?`
/** `4.0 - 11.0`, `120- 160`, `135-145`. */
const BOUNDED = new RegExp(`^(${NUMBER})\\s*-\\s*(${NUMBER})$`)
/** `<36`, `< 1.8`, `<=7.0`. */
const BELOW = new RegExp(`^<\\s*=?\\s*(${NUMBER})$`)
/** `>=1.30`, `=>60`, `> 5`. */
const ABOVE = new RegExp(`^(?:>\\s*=?|=>)\\s*(${NUMBER})$`)

/**
 * Read a printed reference range.
 *
 * @param text - The `Reference Range` column as printed
 * @returns The bounds the text names — both for `low - high`, only `high` for
 *   `<n` / `<=n`, only `low` for `>n` / `>=n` / `=>n` — with the printed text
 *   kept verbatim; neither bound for anything else
 *
 * @remarks
 * A one-sided range is read as the bound it names, not as the other bound
 * being zero: `<36` is an upper limit, and a value of `0` is inside it.
 */
const parseReferenceRange = (text: string): ReferenceRange => {
  const trimmed = text.trim()
  const bounded = BOUNDED.exec(trimmed)
  if (bounded !== null) {
    return { low: Number(bounded[1]), high: Number(bounded[2]), text: trimmed }
  }
  const below = BELOW.exec(trimmed)
  if (below !== null) return { low: undefined, high: Number(below[1]), text: trimmed }
  const above = ABOVE.exec(trimmed)
  if (above !== null) return { low: Number(above[1]), high: undefined, text: trimmed }
  return { low: undefined, high: undefined, text: trimmed }
}

export { parseReferenceRange }
export type { ReferenceRange }
