import * as fc from 'fast-check'

import { optionalText, text } from '../document/printed-text.ts'
import type * as Lab from './lab.ts'

/**
 * The fast-check arbitrary for a {@link Lab.Type}: a laboratory block a printed
 * layout carries faithfully (at most three address lines). Test-only.
 *
 * @packageDocumentation
 */
const arbitrary: fc.Arbitrary<Lab.Type> = fc.record({
  addressLines: fc.array(text(24), { maxLength: 3 }),
  telephone: optionalText(16),
  tollFree: optionalText(16),
  fax: optionalText(16),
})

export { arbitrary }
