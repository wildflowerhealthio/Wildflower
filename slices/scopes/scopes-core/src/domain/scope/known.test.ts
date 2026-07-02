import { describe, expect, test } from 'vite-plus/test'

import * as Scope from './index.ts'

describe('KnownScope.setFlag / toggleFlag (§7)', () => {
  test('setFlag adds then removes a flag', () => {
    const on = Scope.Known.setFlag([], 'openid', true)
    expect(on.map((k) => k.name)).toEqual(['openid'])
    expect(Scope.Known.setFlag(on, 'openid', false)).toEqual([])
  })

  test('setFlag is idempotent — no duplicate on re-add', () => {
    const on = Scope.Known.setFlag(Scope.Known.setFlag([], 'openid', true), 'openid', true)
    expect(on).toHaveLength(1)
  })

  test('toggleFlag flips membership', () => {
    const on = Scope.Known.toggleFlag([], 'openid')
    expect(on.map((k) => k.name)).toEqual(['openid'])
    expect(Scope.Known.toggleFlag(on, 'openid')).toEqual([])
  })
})
