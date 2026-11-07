import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { DEVICE, patient, storedOf } from './identity-map.test-helpers.ts'
import * as LinkTarget from './link-target.ts'
import * as ReferentTally from './referent-tally.ts'

const STORED_TYRA = storedOf(patient({ id: 's-1', system: DEVICE }))
const DECODED_TYRA = storedOf(patient({ id: 'p-1' }))

describe('ReferentTally.make', () => {
  it('counts a stored record two referents link to once', () => {
    expect(
      ReferentTally.make([
        LinkTarget.Stored({ resource: STORED_TYRA }),
        LinkTarget.Stored({ resource: STORED_TYRA }),
      ])
    ).toEqual({ onServer: 1, fromImport: 0 })
  })

  it('counts a stored link onto a record the import updates once, from the import', () => {
    const updated = storedOf(patient({ id: 's-1', system: DEVICE, family: 'Sanders' }))

    expect(
      ReferentTally.make([
        LinkTarget.Decoded({ resource: updated, storedCopy: Option.some(STORED_TYRA) }),
        LinkTarget.Stored({ resource: STORED_TYRA }),
      ])
    ).toEqual({ onServer: 0, fromImport: 1 })
  })

  it('counts each decoded record once, however many referents it is', () => {
    expect(
      ReferentTally.make([
        LinkTarget.Decoded({ resource: DECODED_TYRA, storedCopy: Option.none() }),
        LinkTarget.Decoded({ resource: DECODED_TYRA, storedCopy: Option.none() }),
      ])
    ).toEqual({ onServer: 0, fromImport: 1 })
  })
})
