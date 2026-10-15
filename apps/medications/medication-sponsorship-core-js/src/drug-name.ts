/**
 * Reduce a name from a program's raw list to the plain text the UI shows and
 * the matcher scores: HTML tags removed, the `&nbsp;` entity read as a space,
 * trademark marks dropped (the `®` / `™` / `©` signs, and a plain-letters `TM`
 * glued to the end of a word, as in `"MyrbetriqTM"`), and whitespace collapsed.
 */
const plainDrugName = (raw: string): string =>
  raw
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[\u00ae\u2122\u00a9]/g, '')
    .replace(/(?<=[a-z])TM\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** A lower-case, hyphen-joined id for a plain drug name (`"Actonel DR"` → `"actonel-dr"`). */
const drugNameSlug = (plainName: string): string =>
  plainName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export { plainDrugName, drugNameSlug }
