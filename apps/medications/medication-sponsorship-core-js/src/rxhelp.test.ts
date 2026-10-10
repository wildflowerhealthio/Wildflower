import { describe, expect, test } from 'vite-plus/test'

import { allProvinces } from './province.ts'
import { decodeRxHelpFile, rxhelpToDrug } from './rxhelp.ts'

// The exact sample shape supplied for the RxHelp `items` array.
const actonel = {
  name: 'Actonel DR®',
  frName: 'Actonel DR®',
  genericName: 'risedronate sodium',
}

describe('rxhelpToDrug', () => {
  test('normalizes the sample entry', () => {
    const drug = rxhelpToDrug(actonel)
    expect(drug.sponsor).toBe('rxhelp')
    expect(drug.id).toBe('actonel-dr')
    expect(drug.brandName).toBe('Actonel DR')
    expect(drug.genericName).toBe('risedronate sodium')
  })

  test('coverage is always every province (RxHelp carries no province restriction)', () => {
    expect(rxhelpToDrug(actonel).provinces).toEqual(allProvinces)
  })
})

describe('decodeRxHelpFile', () => {
  test('decodes the { items: [...] } wrapper', () => {
    const drugs = decodeRxHelpFile({ items: [actonel] })
    expect(drugs).toHaveLength(1)
    expect(drugs[0]?.brandName).toBe('Actonel DR')
  })

  test('throws when items is missing', () => {
    expect(() => decodeRxHelpFile({})).toThrow()
  })
})
