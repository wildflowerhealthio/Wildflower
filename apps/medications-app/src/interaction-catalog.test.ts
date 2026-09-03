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
})
