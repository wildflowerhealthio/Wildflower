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

  test('RxHelp drugs carry no province restriction, so each covers all provinces', () => {
    const rxhelp = catalogs.find((catalog) => catalog.sponsor === 'rxhelp')
    expect(rxhelp?.drugs.length).toBeGreaterThan(0)
    for (const drug of rxhelp?.drugs ?? []) {
      expect(drug.provinces).toHaveLength(13)
    }
  })
})
