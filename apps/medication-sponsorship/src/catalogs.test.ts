import { describe, expect, test } from 'vite-plus/test'

import { catalogs } from './catalogs.ts'

describe('bundled sponsor catalogs', () => {
  test('decodes both programs innoviCares-first', () => {
    expect(catalogs.map((catalog) => catalog.sponsor)).toEqual(['innovicares', 'rxhelp'])
  })

  test('every catalog decodes at least one drug with a brand and provinces', () => {
    for (const catalog of catalogs) {
      expect(catalog.drugs.length).toBeGreaterThan(0)
      for (const drug of catalog.drugs) {
        expect(drug.brandName.length).toBeGreaterThan(0)
        expect(drug.provinces.length).toBeGreaterThan(0)
      }
    }
  })

  test('an entry with empty province coverage is expanded to all provinces', () => {
    const synthroid = catalogs[0]?.drugs.find((drug) => drug.brandName === 'Synthroid')
    expect(synthroid?.provinces).toHaveLength(13)
  })
})
