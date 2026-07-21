import { describe, expect, test } from 'vite-plus/test'

import { allProvinces } from './province.ts'
import { decodeRxHelpFile, rxhelpToDrug } from './rxhelp.ts'

// The exact sample shape supplied for the RxHelp `items` array.
const actonel = {
  encId: 'ZbXW7B90k1ALelD',
  name: 'Actonel DR®',
  nameHtml: '<p><strong>Actonel DR®</strong></p>',
  frName: 'Actonel DR®',
  frNameHtml: '<p><strong>Actonel DR®</strong></p>',
  logo: { encId: 'jY4PJ5eODBpQGWd', name: 'a.jpg', content: 'data:image/jpeg;base64,AAAA' },
  provinces: [] as string[],
  genericName: 'risedronate sodium',
  promotionalText: '',
}

describe('rxhelpToDrug', () => {
  test('normalizes the sample entry', () => {
    const drug = rxhelpToDrug(actonel)
    expect(drug.sponsor).toBe('rxhelp')
    expect(drug.id).toBe('ZbXW7B90k1ALelD')
    expect(drug.brandName).toBe('Actonel DR')
    expect(drug.brandHtml).toBe('<p><strong>Actonel DR®</strong></p>')
    expect(drug.genericName).toBe('risedronate sodium')
    expect(drug.logoDataUri).toBe('data:image/jpeg;base64,AAAA')
  })

  test('an empty province array means covered everywhere', () => {
    expect(rxhelpToDrug(actonel).provinces).toEqual(allProvinces)
  })

  test('a populated province array is respected; unknown tokens dropped', () => {
    const drug = rxhelpToDrug({ ...actonel, provinces: ['on', ' bc ', 'ZZ'] })
    expect(drug.provinces).toEqual(['ON', 'BC'])
  })

  test('falls back to a slug id when encId is absent', () => {
    const { encId: _encId, ...withoutId } = actonel
    expect(rxhelpToDrug(withoutId).id).toBe('actonel-dr')
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
