import { severityBetween } from 'medication-interaction-core'
import { describe, expect, test } from 'vite-plus/test'

import { interactionCatalog } from './interaction-catalog.ts'

describe('bundled interaction catalog', () => {
  test('attributes DDInter as its source', () => {
    expect(interactionCatalog.source.name).toBe('DDInter')
    expect(interactionCatalog.source.url).toBe('https://ddinter.scbdd.com/')
  })

  test('every drug carries a DDInter id and a name, at its own index', () => {
    for (const [index, drug] of interactionCatalog.drugs.entries()) {
      expect(drug.index).toBe(index)
      expect(drug.id.length).toBeGreaterThan(0)
      expect(drug.name.length).toBeGreaterThan(0)
    }
  })

  test('bundles the real DDInter data, not the empty placeholder', () => {
    expect(interactionCatalog.drugs.length).toBeGreaterThan(1000)
    expect(interactionCatalog.pairs.size).toBeGreaterThan(10000)
  })

  test('reports the well-known Warfarin / Ibuprofen interaction', () => {
    const warfarin = interactionCatalog.drugs.find((drug) => drug.name === 'Warfarin')
    const ibuprofen = interactionCatalog.drugs.find((drug) => drug.name === 'Ibuprofen')
    if (warfarin === undefined || ibuprofen === undefined) {
      throw new Error('bundled catalog is missing Warfarin or Ibuprofen')
    }
    expect(severityBetween(interactionCatalog, warfarin.index, ibuprofen.index)).not.toBeNull()
  })
})
