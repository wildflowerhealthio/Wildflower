import * as fc from 'fast-check'

/**
 * The fast-check text primitives the report entity arbitraries share: a
 * printable value the header parser never mistakes for a label, and its
 * optional (blank) form.
 *
 * @remarks
 * Test-only, imported by the per-entity `arbitrary`s. The constraints are the
 * print's: a value is a trimmed, non-blank run of printable text (a blank run
 * is not printed at all) and never ends in a colon (which would read as a
 * header label).
 *
 * @packageDocumentation
 */

/** Printable text the header parser never mistakes for a label. */
const text = (maxLength = 24): fc.Arbitrary<string> =>
  fc
    .stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,\-/()<>=%#+*]{0,30}$/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s.length > 0 && s.length <= maxLength && !s.endsWith(':'))

/** A value that may be absent (`''`) — the print's blank field. */
const optionalText = (maxLength = 24): fc.Arbitrary<string> =>
  fc.oneof({ arbitrary: text(maxLength), weight: 3 }, { arbitrary: fc.constant(''), weight: 1 })

export { optionalText, text }
