import { describe, expect, test } from 'vite-plus/test'

import { decodeInnovicaresFile, innovicaresToDrug } from './innovicares.ts'
import { allProvinces } from './province.ts'

// The exact sample shape supplied for the innoviCares list.
const abilify = {
  title: 'Abilify®',
  header: 'Abilify<sup>®</sup>',
  subtitle: 'aripiprazole',
  provinces: 'AB,BC,MB,NB,NL,NS,NT,NU,ON,PE,SK,YT',
  image: 'https://www.innovicares.ca/public-images/Brands/abilify_en.png',
  enableBrandPage: true,
  newMolecules: true,
  newToInnovicares: false,
  url: 'https://www.innovicares.ca/en/about-the-card/whats-covered/abilify/',
}

describe('innovicaresToDrug', () => {
  test('normalizes the sample entry', () => {
    const drug = innovicaresToDrug(abilify)
    expect(drug.sponsor).toBe('innovicares')
    expect(drug.brandName).toBe('Abilify')
    expect(drug.brandHtml).toBe('Abilify<sup>®</sup>')
    expect(drug.genericName).toBe('aripiprazole')
    expect(drug.url).toBe(abilify.url)
    expect(drug.imageUrl).toBe(abilify.image)
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
