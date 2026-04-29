import { render } from '@testing-library/react-native'

import { IconSymbol } from './icon-symbol'
import { MAPPING, type IconSymbolName } from './icon-symbol-mapping'

const isIconSymbolName = (s: string): s is IconSymbolName => s in MAPPING
const MAPPED_NAMES: readonly IconSymbolName[] = Object.keys(MAPPING).filter((s) =>
  isIconSymbolName(s)
)

describe('IconSymbol (Android/web fallback)', () => {
  it.each(MAPPED_NAMES.map((name) => [name]))('renders for mapped name %s', (name) => {
    const { unmount } = render(<IconSymbol name={name} color="#000" />)
    unmount()
  })
})

describe('IconSymbolName mapping', () => {
  it('has at least one entry', () => {
    expect(MAPPED_NAMES.length).toBeGreaterThan(0)
  })

  it('values are non-empty strings (Material Icon names)', () => {
    for (const value of Object.values(MAPPING)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })
})
