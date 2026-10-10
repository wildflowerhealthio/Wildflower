import { describe, expect, test } from 'vite-plus/test'

import { decodeInnovicaresFile, innovicaresToDrug } from './innovicares.ts'
import { allProvinces } from './province.ts'

// The exact sample shape supplied for the innoviCares list.
const abilify = {
  title: 'Abilify®',
  subtitle: 'aripiprazole',
  provinces: 'AB,BC,MB,NB,NL,NS,NT,NU,ON,PE,SK,YT',
  url: 'https://www.innovicares.ca/en/about-the-card/whats-covered/abilify/',
}

describe('innovicaresToDrug', () => {
  test('normalizes the sample entry', () => {
    const drug = innovicaresToDrug(abilify)
    expect(drug.sponsor).toBe('innovicares')
    expect(drug.brandName).toBe('Abilify')
    expect(drug.genericName).toBe('aripiprazole')
    expect(drug.url).toBe(abilify.url)
    expect(drug.id).toBe('abilify')
  })

  test('parses the comma-separated province list (QC absent → not covered)', () => {
    const drug = innovicaresToDrug(abilify)
    expect(drug.provinces).toContain('ON')
    expect(drug.provinces).not.toContain('QC')
    expect(drug.provinces).toHaveLength(12)
  })

  test('an absent/empty province string means covered everywhere', () => {
    expect(innovicaresToDrug({ title: 'X' }).provinces).toEqual(allProvinces)
    expect(innovicaresToDrug({ title: 'X', provinces: '' }).provinces).toEqual(allProvinces)
  })

  test('an entry with no url falls back to the innoviCares home page', () => {
    expect(innovicaresToDrug({ title: 'X' }).url).toBe('https://www.innovicares.ca/en/')
    expect(innovicaresToDrug({ title: 'X', url: '  ' }).url).toBe('https://www.innovicares.ca/en/')
    expect(innovicaresToDrug({ title: 'X', url: 'https://example.test/x' }).url).toBe(
      'https://example.test/x'
    )
  })
})

describe('decodeInnovicaresFile', () => {
  test('decodes a bare array of entries', () => {
    const drugs = decodeInnovicaresFile([abilify])
    expect(drugs).toHaveLength(1)
    expect(drugs[0]?.brandName).toBe('Abilify')
  })

  test('throws on a malformed file', () => {
    expect(() => decodeInnovicaresFile({ not: 'an array' })).toThrow()
  })
})
