import { describe, expect, it } from 'vite-plus/test'

import { decodeDdinterFile } from './ddinter.ts'
import { matchCatalogDrugs } from './match.ts'

describe('matchCatalogDrugs', () => {
  it('should resolve every ingredient of a combination product', () => {
    const matches = matchCatalogDrugs('Acetaminophen with Codeine 300 mg/30 mg tablet', catalog)
    expect(matches.map((match) => match.drug.name).toSorted()).toEqual(['Acetaminophen', 'Codeine'])
    expect(matches.every((match) => match.confidence === 'strong')).toBe(true)
  })

  it('should resolve an exact name at exact confidence', () => {
    const matches = matchCatalogDrugs('warfarin', catalog)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.confidence).toBe('exact')
  })

  it('should fall back to partial matches only when nothing is contained', () => {
    const matches = matchCatalogDrugs('Iron', catalog)
    expect(matches.map((match) => match.drug.name)).toEqual(['Iron sucrose'])
    expect(matches[0]?.confidence).toBe('partial')
  })

  it('should not let a partial match dilute a definite one', () => {
    // "Iron sucrose 20 mg/mL" contains "Iron sucrose" exactly; the bare "iron"
    // entry would only be a partial neighbour and is not consulted.
    const matches = matchCatalogDrugs('Iron sucrose 20 mg/mL injection', catalog)
    expect(matches.map((match) => match.drug.name)).toEqual(['Iron sucrose'])
  })

  it('should resolve nothing for a brand-only name DDInter does not carry', () => {
    expect(matchCatalogDrugs('Tylenol Extra Strength', catalog)).toEqual([])
  })

  it('should resolve nothing for an empty name', () => {
    expect(matchCatalogDrugs('', catalog)).toEqual([])
  })

  it('should drop a partial match that only holds via a parenthetical qualifier', () => {
    // "Insulin human (zinc)" is a zinc-formulated insulin, not a zinc product;
    // the bare "Zinc" entry must not resolve to it.
    expect(matchCatalogDrugs('Zinc', catalog)).toEqual([])
  })

  it('should still partial-match when the shared token is outside parentheses', () => {
    // The qualifier here disambiguates a route, not a different drug, so the
    // bare name should still find it.
    const matches = matchCatalogDrugs('Oxymetazoline', catalog)
    expect(matches.map((match) => match.drug.name)).toEqual(['Oxymetazoline (nasal)'])
    expect(matches[0]?.confidence).toBe('partial')
  })
})

// Helpers

const catalog = decodeDdinterFile({
  source: { name: 'DDInter', url: 'https://ddinter.scbdd.com/' },
  drugs: [
    ['DDInter1', 'Warfarin'],
    ['DDInter2', 'Acetaminophen'],
    ['DDInter3', 'Codeine'],
    ['DDInter4', 'Iron sucrose'],
    ['DDInter5', 'Insulin human (zinc)'],
    ['DDInter6', 'Oxymetazoline (nasal)'],
  ],
  pairs: [],
})
