import { describe, expect, test } from 'vite-plus/test'

import { readAccess, starAccess, writeAccess } from './access.ts'
import { accessVerbLabel, verbLabel } from './verbs.ts'

describe('verbLabel — sentence-style join', () => {
  test('zero / one / two / many', () => {
    expect(verbLabel([])).toBe('')
    expect(verbLabel(['r'])).toBe('Read')
    expect(verbLabel(['r', 's'])).toBe('Read and Search')
    expect(verbLabel(['c', 'r', 's'])).toBe('Create, Read and Search')
    expect(verbLabel(['c', 'r', 'u', 'd', 's'])).toBe('Create, Read, Update, Destroy and Search')
  })

  test('orders canonically regardless of input order', () => {
    expect(verbLabel(['s', 'c', 'r'])).toBe('Create, Read and Search')
  })

  test('accessVerbLabel labels a v1 word by its Read/Write parts', () => {
    expect(accessVerbLabel(readAccess)).toBe('Read')
    expect(accessVerbLabel(writeAccess)).toBe('Write')
    expect(accessVerbLabel(starAccess)).toBe('Read and Write')
  })
})
