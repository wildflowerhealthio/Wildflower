import { MatchQuery } from '@wildflowerhealthio/fhir-r4/clients'
import { Array as Arr, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { detached, OTHER_SOURCE, tyraWire } from '../import-plan.test-helpers.ts'
import * as OfferedFields from './offered-fields.ts'

/** Covers what offered fields hold and when they offer no field. */

/** The qualified identifier Tyra carries under the other source. */
const otherSourceIdentifier = Option.getOrThrow(
  Arr.head(MatchQuery.qualifiedIdentifiersOf(detached(tyraWire('tyra', {}, OTHER_SOURCE))))
)

describe('OfferedFields.make', () => {
  it('should hold its gap-filling and overwriting fields and the identifiers it adds', () => {
    // Arrange / Act
    const offeredFields = OfferedFields.make({
      gapFilling: ['gender'],
      overwriting: ['birthDate'],
      identifiersToAdd: [otherSourceIdentifier],
    })

    // Assert
    expect(offeredFields).toEqual({
      gapFilling: ['gender'],
      overwriting: ['birthDate'],
      identifiersToAdd: [otherSourceIdentifier],
    })
  })
})

describe('OfferedFields.offersNoField', () => {
  it('should offer no field when nothing fills a gap or overwrites, whatever identifiers it adds', () => {
    // Arrange
    const offered = [
      OfferedFields.make({ gapFilling: [], overwriting: [], identifiersToAdd: [] }),
      OfferedFields.make({
        gapFilling: [],
        overwriting: [],
        identifiersToAdd: [otherSourceIdentifier],
      }),
      OfferedFields.make({ gapFilling: ['gender'], overwriting: [], identifiersToAdd: [] }),
      OfferedFields.make({ gapFilling: [], overwriting: ['birthDate'], identifiersToAdd: [] }),
    ]

    // Act
    const offersNoField = offered.map(OfferedFields.offersNoField)

    // Assert
    expect(offersNoField).toEqual([true, true, false, false])
  })
})
