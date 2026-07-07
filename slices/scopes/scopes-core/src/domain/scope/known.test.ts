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

describe('KnownScope.inCanonicalOrder (§7)', () => {
  test('reorders flags into the canonical Name.all order', () => {
    const flags = [
      new Scope.Known('launch/patient'),
      new Scope.Known('offline_access'),
      new Scope.Known('openid'),
    ]
    expect(Scope.Known.inCanonicalOrder(flags)).toEqual([
      new Scope.Known('openid'),
      new Scope.Known('offline_access'),
      new Scope.Known('launch/patient'),
    ])
  })

  test('de-duplicates by name', () => {
    const flags = [new Scope.Known('openid'), new Scope.Known('openid')]
    expect(Scope.Known.inCanonicalOrder(flags)).toEqual([new Scope.Known('openid')])
  })
})
