/**
 * The string, or `null` when it is absent (`null` / `undefined`) or empty.
 *
 * @remarks
 * Collapses the "missing" and "present but blank" cases into one `null`, which
 * is what most read-a-field-for-display code actually wants: JSON payloads
 * routinely send `""` for a value the source holds nothing for, and treating
 * that as present produces empty labels, empty name entries, and links to
 * nowhere.
 *
 * Only length is checked — a whitespace-only string is returned as-is, since
 * trimming is a separate decision the caller may not want (e.g. preformatted
 * text). Trim first if blank-means-absent should include whitespace.
 */
const nonEmpty = (value: string | null | undefined): string | null =>
  value !== null && value !== undefined && value.length > 0 ? value : null

export { nonEmpty }
