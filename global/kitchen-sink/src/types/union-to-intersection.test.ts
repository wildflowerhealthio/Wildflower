import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { UnionToIntersection } from './union-to-intersection.ts'

describe('UnionToIntersection', () => {
  it('intersects two disjoint object types', () => {
    expectTypeOf<UnionToIntersection<{ a: 1 } | { b: 2 }>>().toEqualTypeOf<
      { a: 1 } & { b: 2 }
    >()
  })

  it('intersects three disjoint object types', () => {
    expectTypeOf<UnionToIntersection<{ a: 1 } | { b: 2 } | { c: 3 }>>().toEqualTypeOf<
      { a: 1 } & { b: 2 } & { c: 3 }
    >()
  })

  it('produces never for primitive unions whose intersection is empty', () => {
    expectTypeOf<UnionToIntersection<string | number>>().toEqualTypeOf<never>()
  })

  it('returns the same type for a non-union input', () => {
    expectTypeOf<UnionToIntersection<{ a: 1 }>>().toEqualTypeOf<{ a: 1 }>()
  })
})
