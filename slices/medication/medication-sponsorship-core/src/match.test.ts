import { Arbitrary } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { normalizeName } from 'medication-core'
import { describe, expect, test } from 'vite-plus/test'

import { matchDrug, matchMedication } from './match.ts'
import { allProvinces } from './province.ts'
import type { Medication, SponsoredDrug } from './sponsor.ts'
import { SponsoredDrug as SponsoredDrugSchema } from './sponsor.ts'

const drug = (over: Partial<SponsoredDrug>): SponsoredDrug => ({
  sponsor: 'innovicares',
  id: 'x',
  brandName: 'Abilify',
  genericName: 'aripiprazole',
  provinces: allProvinces,
  ...over,
})

const med = (displayName: string): Medication => ({ id: 'm', displayName })

describe('matchDrug', () => {
  test('exact brand match when names normalize equal', () => {
    const result = matchDrug(med('ABILIFY'), drug({}))
    expect(result).not.toBeNull()
    expect(result?.field).toBe('brand')
    expect(result?.confidence).toBe('exact')
  })

  test('strong match when the brand is contained in a fuller med name', () => {
    const result = matchDrug(med('Abilify 5 mg tablet'), drug({}))
    expect(result?.field).toBe('brand')
    expect(result?.confidence).toBe('strong')
  })

  test('matches on generic name', () => {
    const result = matchDrug(med('aripiprazole'), drug({}))
    expect(result?.field).toBe('generic')
    expect(result?.confidence).toBe('exact')
  })

  test('partial match when the med name is a subset of the generic', () => {
    const result = matchDrug(
      med('risedronate'),
      drug({ brandName: 'Actonel DR', genericName: 'risedronate sodium' })
    )
    expect(result?.field).toBe('generic')
    expect(result?.confidence).toBe('partial')
  })

  test('brand wins over generic at equal confidence', () => {
    // Both brand and generic exact-match "same" — brand should be reported.
    const result = matchDrug(med('same'), drug({ brandName: 'same', genericName: 'same' }))
    expect(result?.field).toBe('brand')
  })

  test('no match returns null', () => {
    expect(matchDrug(med('ibuprofen'), drug({}))).toBeNull()
  })

  test('a drug with empty names never matches', () => {
    expect(matchDrug(med('anything'), drug({ brandName: '', genericName: '' }))).toBeNull()
  })

  test('a medication whose name equals the brand always matches exactly', () => {
    const drugArb = Arbitrary.make(SponsoredDrugSchema).filter(
      (candidate) => normalizeName(candidate.brandName).length > 0
    )
    fc.assert(
      fc.property(drugArb, (candidate) => {
        const result = matchDrug(med(candidate.brandName), candidate)
        expect(result).not.toBeNull()
        expect(result?.confidence).toBe('exact')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('matchMedication', () => {
  test('returns null over an empty drug list', () => {
    expect(matchMedication(med('Abilify'), [])).toBeNull()
  })

  test('finds the matching drug in a list', () => {
    const drugs = [
      drug({ id: 'a', brandName: 'Lipitor', genericName: 'atorvastatin' }),
      drug({ id: 'b' }),
    ]
    const result = matchMedication(med('Abilify'), drugs)
    expect(result?.drug.id).toBe('b')
  })

  test('a strictly higher-confidence later match displaces an earlier partial', () => {
    const partial = drug({ id: 'partial', brandName: 'zzz', genericName: 'abilify aripiprazole' })
    const exact = drug({ id: 'exact', brandName: 'Abilify', genericName: 'aripiprazole' })
    const result = matchMedication(med('Abilify'), [partial, exact])
    expect(result?.drug.id).toBe('exact')
    expect(result?.confidence).toBe('exact')
  })
})
