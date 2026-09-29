import { Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import prescriptions from './fixtures/prescriptions-searchset.json' with { type: 'json' }
import profileMe from './fixtures/profile-me.json' with { type: 'json' }
import { MedicationListResponseKind } from './response-kinds/medication-list-response-kind.ts'
import { ProfileResponseKind } from './response-kinds/profile-response-kind.ts'
import { REXALL_PROFILE_URL, REXALL_STU3_BASE_URL, medicationListUrlOf } from './tunnel-url.ts'

const isRecognizedBy = (
  kind: typeof ProfileResponseKind | typeof MedicationListResponseKind,
  url: string
): boolean => Option.isSome(kind.tryRecognize(url, Option.none()))

/** A carebook-style id: what a uid or pharmacy location id looks like. */
const carebookId = fc.stringMatching(/^[A-Za-z0-9-]{1,40}$/)

describe('tunnel URLs', () => {
  describe('REXALL_PROFILE_URL', () => {
    it('is recognized by ProfileResponseKind and not by MedicationListResponseKind', () => {
      expect(isRecognizedBy(ProfileResponseKind, REXALL_PROFILE_URL)).toBe(true)
      expect(isRecognizedBy(MedicationListResponseKind, REXALL_PROFILE_URL)).toBe(false)
    })
  })

  describe('medicationListUrlOf', () => {
    it("builds the capture's searchset URL for the capture's account", () => {
      const captured = prescriptions.link.find(({ relation }) => relation === 'self')?.url
      expect(
        medicationListUrlOf({
          profileUid: profileMe.data.identifiers.uid,
          pharmacyLocationId: 'pharmacy-4821',
        })
      ).toBe(captured)
    })

    it('is recognized by MedicationListResponseKind and not by ProfileResponseKind', () => {
      fc.assert(
        fc.property(carebookId, carebookId, (profileUid, pharmacyLocationId) => {
          const url = medicationListUrlOf({ profileUid, pharmacyLocationId })
          expect(isRecognizedBy(MedicationListResponseKind, url)).toBe(true)
          expect(isRecognizedBy(ProfileResponseKind, url)).toBe(false)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })

  describe('REXALL_STU3_BASE_URL', () => {
    it("roots every fullUrl in the capture's searchset", () => {
      for (const { fullUrl } of prescriptions.entry) {
        expect(fullUrl.startsWith(`${REXALL_STU3_BASE_URL}/`)).toBe(true)
      }
    })
  })
})
