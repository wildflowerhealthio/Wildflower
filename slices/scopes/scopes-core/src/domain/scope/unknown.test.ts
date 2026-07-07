import { Equal } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import * as Scope from './index.ts'

describe('UnknownScope equality', () => {
  test('two instances of the same raw string are Equal.equals', () => {
    expect(Equal.equals(new Scope.Unknown('x-custom'), new Scope.Unknown('x-custom'))).toBe(true)
  })

  test('different raw strings are not Equal.equals', () => {
    expect(Equal.equals(new Scope.Unknown('x-custom'), new Scope.Unknown('x-other'))).toBe(false)
  })
})
