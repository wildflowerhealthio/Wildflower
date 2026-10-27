import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { DEVICE, patient, storedOf } from './identity-map.test-helpers.ts'
import * as LinkTarget from './link-target.ts'
import * as ReferentTally from './referent-tally.ts'

const STORED_TYRA = storedOf(patient({ id: 's-1', system: DEVICE }))
const DECODED_TYRA = storedOf(patient({ id: 'p-1' }))

describe('ReferentTally.of', () => {
  it('counts a stored record two referents link to once', () => {
    expect(
      ReferentTally.of([
        LinkTarget.Stored({ resource: STORED_TYRA }),
        LinkTarget.Stored({ resource: STORED_TYRA }),
      ])
    ).toEqual({ onServer: 1, fromImport: 0, unlinked: 0 })
  })

  it('counts a stored link onto a record the import updates once, from the import', () => {
    const updated = storedOf(patient({ id: 's-1', system: DEVICE, family: 'Sanders' }))

    expect(
      ReferentTally.of([
        LinkTarget.Decoded({ resource: updated, storedCopy: Option.some(STORED_TYRA) }),
        LinkTarget.Stored({ resource: STORED_TYRA }),
      ])
    ).toEqual({ onServer: 0, fromImport: 1, unlinked: 0 })
  })

  it('counts each unlinked referent', () => {
    expect(
      ReferentTally.of([
        LinkTarget.Decoded({ resource: DECODED_TYRA, storedCopy: Option.none() }),
        LinkTarget.Unlinked(),
        LinkTarget.Unlinked(),
      ])
    ).toEqual({ onServer: 0, fromImport: 1, unlinked: 2 })
  })
})
