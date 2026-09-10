import * as fc from 'fast-check'

import { text } from '../document/printed-text.ts'
import type * as Group from './group.ts'
import { arbitrary as testTableRowArbitrary } from './test-table-row-arbitrary.ts'

/**
 * The fast-check arbitrary for a {@link Group.Type}. Only a section's leading
 * group may be `unnamed` — and an unnamed group is never empty, since nothing
 * would print it. Test-only.
 *
 * @packageDocumentation
 */
const arbitrary = (licence: fc.Arbitrary<string>, unnamed: boolean): fc.Arbitrary<Group.Type> =>
  fc.record({
    name: unnamed ? fc.constant('') : text(30),
    rows: fc.array(testTableRowArbitrary(licence), { minLength: unnamed ? 1 : 0, maxLength: 4 }),
  })

export { arbitrary }
