import * as fc from 'fast-check'

import { text } from '../document/printed-text.ts'
import type * as TestTableRow from './test-table-row.ts'

/**
 * The fast-check arbitrary for a {@link TestTableRow.Type}: a grid row a
 * printed layout carries faithfully, its lab licence drawn from the report's
 * licence sequence (see `report-arbitrary.ts`). Test-only.
 *
 * @packageDocumentation
 */
const arbitrary = (labLicence: fc.Arbitrary<string>): fc.Arbitrary<TestTableRow.Type> => {
  const numberText = fc
    .double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true })
    .map((n) => n.toFixed(fc.sample(fc.integer({ min: 0, max: 3 }), 1)[0] ?? 1))
  return fc.record({
    name: text(40),
    flag: fc.constantFrom('', '', 'HI', 'LO'),
    result: fc.oneof(
      numberText,
      numberText.map((n) => `<${n}`),
      fc.constantFrom('NEGATIVE', 'NOT DETECTED', 'YELLOW', 'CLEAR', '08:11', '04-SEP-2024', '')
    ),
    referenceRange: fc.oneof(
      fc.tuple(numberText, numberText).map(([low, high]) => `${low} - ${high}`),
      numberText.map((n) => `<${n}`),
      numberText.map((n) => `>=${n}`),
      fc.constantFrom('See below', 'NEGATIVE', '')
    ),
    unit: fc.constantFrom('', 'x E9/L', 'mmol/L', 'umol/L', 'g/L', '%', 'U/L', 'pmol/L', 'hours'),
    labLicence,
    comments: fc.array(text(48), { maxLength: 3 }),
  })
}

export { arbitrary }
