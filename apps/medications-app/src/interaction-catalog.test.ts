import { decodeDdinterFile, severityBetween } from 'medication-interaction-core'
import { describe, expect, test } from 'vite-plus/test'

import ddinterData from './data/ddinter/ddinter.json'
import ddinterUrl from './data/ddinter/ddinter.json?url'

// The data is decoded from a direct JSON import here rather than through
// `getInteractionCatalog`, which fetches the file as a `?url` asset — a
// transport with no server in the test pool. Decoding the imported data
// exercises the bundled file's validity, which is what these tests are about.
const interactionCatalog = decodeDdinterFile(ddinterData)

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

  // Regression guard for an iOS-only crash: with ~160k interaction pairs, a
  // plain JSON import inlines the data into the app chunk as a giant JS array
  // literal, which overflows JavaScriptCore's compiler while the module is
  // evaluated (`RangeError: Maximum call stack size exceeded`) — before any app
  // code runs, so nothing catches it. Loading it as a fetched `?url` asset keeps
  // the data a plain string parsed by the native `Response.json()`. This pins
  // that the loader points at an external asset, not an inlined object.
  test('loads the catalog as a fetched asset, not an inlined literal', () => {
    expect(typeof ddinterUrl).toBe('string')
    expect(ddinterUrl).toMatch(/ddinter.*\.json/)
  })
})
