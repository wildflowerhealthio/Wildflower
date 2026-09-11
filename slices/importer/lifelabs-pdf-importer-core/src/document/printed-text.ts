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
 * The pool is picked from `constantFrom` rather than generated through
 * `fc.stringMatching` — an `fc.stringMatching` for every text field feeds
 * hundreds of regex walks per property run and dominates the property test's
 * runtime (the same trade `fhir-r4/data-types/base/primitives.ts` calls out).
 * Every entry is chosen from the print's alphabet
 * (`[A-Za-z0-9 .,\-/()<>=%#+*]`), is trimmed and non-blank, does not end in
 * `:`, and is at most 12 characters long so any caller's `maxLength` (the
 * smallest is 12) passes it through.
 *
 * @packageDocumentation
 */

const POOL = [
  'A',
  'X',
  '1',
  '9',
  'A1',
  'ABC',
  'Foo',
  'Bar',
  'Item 1',
  'Item 2',
  'Value',
  'Test',
  'Report',
  'A.B',
  'A-B',
  'A/B',
  'A(B)',
  '<Foo>',
  'A=1',
  'A+B',
  'A,B',
  '#42',
  '10%',
  '2024',
  'Foo Bar 1',
] as const

/** Printable text the header parser never mistakes for a label. */
const text = (maxLength = 24): fc.Arbitrary<string> =>
  fc.constantFrom(...POOL).filter((s) => s.length <= maxLength)

/** A value that may be absent (`''`) — the print's blank field. */
const optionalText = (maxLength = 24): fc.Arbitrary<string> =>
  fc.oneof({ arbitrary: text(maxLength), weight: 3 }, { arbitrary: fc.constant(''), weight: 1 })

export { optionalText, text }
