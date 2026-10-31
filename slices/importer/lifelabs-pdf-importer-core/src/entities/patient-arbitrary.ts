import * as fc from 'fast-check'

import { optionalText, text } from '../document/printed-text.ts'
import type * as Patient from './patient.ts'

/**
 * The fast-check arbitrary for a {@link Patient.Type}: a patient block a
 * printed layout carries faithfully. Test-only — kept out of `patient.ts` so
 * `fast-check` stays out of the production bundle.
 *
 * @packageDocumentation
 */
const arbitrary: fc.Arbitrary<Patient.Type> = fc.record({
  name: fc.oneof(
    fc.tuple(text(12), text(12)).map(([family, given]) => `${family.toUpperCase()}, ${given}`),
    fc.constant('')
  ),
  age: optionalText(12),
  sex: fc.constantFrom('F', 'M', ''),
  dateOfBirth: fc.constantFrom('Aug 13 1981', 'Feb 29 1996', 'Xxx 00 0000', ''),
  healthCardNumber: fc.constantFrom('1234567890 AB', '0000000000 XX', ''),
  phone: fc.constantFrom('(416) 555-0100', ''),
  patientId: optionalText(14),
})

export { arbitrary }
