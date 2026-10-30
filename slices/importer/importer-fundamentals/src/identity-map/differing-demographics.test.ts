import { describe, expect, it } from 'vite-plus/test'

import * as DifferingDemographics from './differing-demographics.ts'
import {
  DEVICE,
  patient,
  practitioner,
  runOnTestClock,
  storedOf,
} from './identity-map.test-helpers.ts'

/** The demographics differing between `decoded` and `stored`, on the test clock. */
const differingOnTestClock = (
  decoded: Parameters<typeof DifferingDemographics.between>[0],
  stored: Parameters<typeof DifferingDemographics.between>[1]
): readonly DifferingDemographics.Demographic[] =>
  runOnTestClock(DifferingDemographics.between(decoded, stored))

describe('DifferingDemographics.between', () => {
  it('names a family name the two Patients state differently', () => {
    expect(
      differingOnTestClock(
        storedOf(patient({ id: 'p-1', family: 'Banks' })),
        storedOf(patient({ id: 's-1', system: DEVICE, family: 'Sanders' }))
      )
    ).toEqual(['FamilyName'])
  })

  it('names a birth date the two Patients state differently', () => {
    expect(
      differingOnTestClock(
        storedOf(patient({ id: 'p-1', birthDate: '1990-01-02' })),
        storedOf(patient({ id: 's-1', system: DEVICE, birthDate: '1991-03-04' }))
      )
    ).toEqual(['BirthDate'])
  })

  it('names nothing when one side states no birth date', () => {
    expect(
      differingOnTestClock(
        storedOf(patient({ id: 'p-1', birthDate: '1990-01-02' })),
        storedOf(patient({ id: 's-1', system: DEVICE, birthDate: null }))
      )
    ).toEqual([])
  })

  it('compares nothing for a Practitioner pair', () => {
    expect(
      differingOnTestClock(
        storedOf(practitioner('pr-1', 'Dr. A Smith')),
        storedOf(practitioner('pr-2', 'Dr. B Jones', DEVICE))
      )
    ).toEqual([])
  })
})
