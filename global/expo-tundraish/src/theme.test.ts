import { Colors, FontSize, FontWeight, LetterSpacing, LineHeight, Spacing } from './theme'

describe('Colors', () => {
  it('light and dark palettes share the same keys', () => {
    expect(Object.keys(Colors.light).toSorted()).toEqual(Object.keys(Colors.dark).toSorted())
  })

  it('every value is a non-empty string', () => {
    for (const palette of [Colors.light, Colors.dark]) {
      for (const value of Object.values(palette)) {
        expect(typeof value).toBe('string')
        expect(value.length).toBeGreaterThan(0)
      }
    }
  })

  it('dark cardBackground and surfacePressed differ (so card-press feedback is visible)', () => {
    expect(Colors.dark.surfacePressed).not.toBe(Colors.dark.cardBackground)
  })
})

describe('Spacing', () => {
  it('is monotonically non-decreasing across s1..s13', () => {
    const order = [
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7',
      's8',
      's9',
      's10',
      's11',
      's12',
      's13',
    ] as const
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1]
      const curr = order[i]
      if (!prev || !curr) throw new Error('unreachable')
      expect(Spacing[curr]).toBeGreaterThanOrEqual(Spacing[prev])
    }
  })
})

describe('Typography tokens', () => {
  it('FontSize values are positive numbers', () => {
    for (const v of Object.values(FontSize)) {
      expect(v).toBeGreaterThan(0)
    }
  })

  it('FontWeight values are numeric strings', () => {
    for (const v of Object.values(FontWeight)) {
      expect(/^\d+$/.test(v)).toBe(true)
    }
  })

  it('LineHeight tight is the smallest, relaxed is the largest', () => {
    const values = Object.values(LineHeight)
    expect(LineHeight.tight).toBe(Math.min(...values))
    expect(LineHeight.relaxed).toBe(Math.max(...values))
  })

  it('LetterSpacing tighter < tight < normal < wide < wider', () => {
    expect(LetterSpacing.tighter).toBeLessThan(LetterSpacing.tight)
    expect(LetterSpacing.tight).toBeLessThan(LetterSpacing.normal)
    expect(LetterSpacing.normal).toBeLessThan(LetterSpacing.wide)
    expect(LetterSpacing.wide).toBeLessThan(LetterSpacing.wider)
  })
})
