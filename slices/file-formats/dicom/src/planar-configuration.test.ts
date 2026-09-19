import { describe, expect, it } from 'vite-plus/test'

import * as PlanarConfiguration from './planar-configuration.ts'

describe('PlanarConfiguration.meaning', () => {
  it('names both enumerated interleavings', () => {
    expect(PlanarConfiguration.meaning(0)).toBe('colour-by-pixel')
    expect(PlanarConfiguration.meaning(1)).toBe('colour-by-plane')
  })

  it('returns undefined for a value outside the enumeration', () => {
    expect(PlanarConfiguration.meaning(2)).toBeUndefined()
    expect(PlanarConfiguration.meaning(-1)).toBeUndefined()
  })
})
