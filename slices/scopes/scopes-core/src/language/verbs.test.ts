import { describe, expect, test } from 'vite-plus/test'

import { AccessRights, Verbs } from '../index.ts'

describe('Verbs.label — sentence-style join', () => {
  test('zero / one / two / many', () => {
    expect(Verbs.label([])).toBe('')
    expect(Verbs.label(['r'])).toBe('Read')
    expect(Verbs.label(['r', 's'])).toBe('Read and Search')
    expect(Verbs.label(['c', 'r', 's'])).toBe('Create, Read and Search')
    expect(Verbs.label(['c', 'r', 'u', 'd', 's'])).toBe('Create, Read, Update, Destroy and Search')
  })

  test('orders canonically regardless of input order', () => {
    expect(Verbs.label(['s', 'c', 'r'])).toBe('Create, Read and Search')
  })

  test('accessLabel labels a v1 word by its Read/Write parts', () => {
    expect(Verbs.accessLabel(AccessRights.read)).toBe('Read')
    expect(Verbs.accessLabel(AccessRights.write)).toBe('Write')
    expect(Verbs.accessLabel(AccessRights.star)).toBe('Read and Write')
  })
})
