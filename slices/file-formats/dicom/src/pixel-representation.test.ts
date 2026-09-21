import { describe, expect, it } from 'vite-plus/test'

import * as PixelRepresentation from './pixel-representation.ts'

describe('PixelRepresentation.meaning', () => {
  it('names both enumerated representations', () => {
    expect(PixelRepresentation.meaning(0)).toBe('unsigned')
    expect(PixelRepresentation.meaning(1)).toBe('signed (two’s complement)')
  })

  it('returns undefined for a value outside the enumeration', () => {
    expect(PixelRepresentation.meaning(2)).toBeUndefined()
  })
})
