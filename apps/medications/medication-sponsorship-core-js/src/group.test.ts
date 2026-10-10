import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { groupMedications, type SponsorCatalog } from './group.ts'
import { allProvinces } from './province.ts'
import type { Medication, SponsoredDrug } from './sponsor.ts'

const drug = (
  over: Partial<SponsoredDrug> & Pick<SponsoredDrug, 'sponsor' | 'brandName'>
): SponsoredDrug => ({
  id: over.brandName,
  genericName: '',
  provinces: allProvinces,
  ...over,
})

const med = (id: string, displayName: string): Medication => ({ id, displayName })

const innovicares: SponsoredDrug[] = [
  drug({ sponsor: 'innovicares', brandName: 'Abilify', genericName: 'aripiprazole' }),
]
const rxhelp: SponsoredDrug[] = [
  drug({ sponsor: 'rxhelp', brandName: 'Actonel DR', genericName: 'risedronate sodium' }),
]
const catalogs: readonly SponsorCatalog[] = [
  { sponsor: 'innovicares', drugs: innovicares },
  { sponsor: 'rxhelp', drugs: rxhelp },
]

describe('groupMedications', () => {
  test('places medications into their matching sponsor group', () => {
    const result = groupMedications(
      [med('1', 'Abilify 5 mg'), med('2', 'Actonel DR'), med('3', 'ibuprofen')],
      { province: 'ON', catalogs }
    )
    expect(result.sponsored[0]?.sponsor).toBe('innovicares')
    expect(result.sponsored[0]?.items.map((i) => i.medication.id)).toEqual(['1'])
    expect(result.sponsored[1]?.sponsor).toBe('rxhelp')
    expect(result.sponsored[1]?.items.map((i) => i.medication.id)).toEqual(['2'])
    expect(result.unsponsored.map((m) => m.id)).toEqual(['3'])
  })

  test('always emits one group per catalog, in order, even when empty', () => {
    const result = groupMedications([], { province: 'ON', catalogs })
    expect(result.sponsored.map((g) => g.sponsor)).toEqual(['innovicares', 'rxhelp'])
    expect(result.sponsored.every((g) => g.items.length === 0)).toBe(true)
  })

  test('a drug not covering the province does not sponsor the med', () => {
    const bcOnly: SponsorCatalog = {
      sponsor: 'innovicares',
      drugs: [drug({ sponsor: 'innovicares', brandName: 'Abilify', provinces: ['BC'] })],
    }
    const result = groupMedications([med('1', 'Abilify')], { province: 'ON', catalogs: [bcOnly] })
    expect(result.sponsored[0]?.items).toEqual([])
    expect(result.unsponsored.map((m) => m.id)).toEqual(['1'])
  })

  test('catalog order sets precedence when a med matches more than one program', () => {
    const both: SponsoredDrug = drug({ sponsor: 'rxhelp', brandName: 'Abilify' })
    const innovicaresFirst = groupMedications([med('1', 'Abilify')], {
      province: 'ON',
      catalogs: [
        { sponsor: 'innovicares', drugs: innovicares },
        { sponsor: 'rxhelp', drugs: [both] },
      ],
    })
    expect(innovicaresFirst.sponsored[0]?.items.map((i) => i.medication.id)).toEqual(['1'])
    expect(innovicaresFirst.sponsored[1]?.items).toEqual([])

    const rxhelpFirst = groupMedications([med('1', 'Abilify')], {
      province: 'ON',
      catalogs: [
        { sponsor: 'rxhelp', drugs: [both] },
        { sponsor: 'innovicares', drugs: innovicares },
      ],
    })
    expect(rxhelpFirst.sponsored[0]?.items.map((i) => i.medication.id)).toEqual(['1'])
    expect(rxhelpFirst.sponsored[1]?.items).toEqual([])
  })

  test('every medication lands in exactly one bucket (partition is total)', () => {
    const medArb = fc
      .record({
        id: fc.string({ minLength: 1 }),
        displayName: fc.oneof(fc.constant('Abilify'), fc.constant('Actonel DR'), fc.string()),
      })
      .map(({ id, displayName }): Medication => ({ id, displayName }))
    fc.assert(
      fc.property(fc.array(medArb), (meds) => {
        const result = groupMedications(meds, { province: 'ON', catalogs })
        const grouped = result.sponsored.reduce((sum, g) => sum + g.items.length, 0)
        expect(grouped + result.unsponsored.length).toBe(meds.length)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
