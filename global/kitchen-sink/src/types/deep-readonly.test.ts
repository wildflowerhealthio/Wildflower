import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { DeepReadonly } from './deep-readonly.ts'

describe('DeepReadonly', () => {
  it('should apply deeply', () => {
    expectTypeOf<DeepReadonly<{ a: { b: number[] } }[]>>([
      { a: { b: [1, 2, 3] } },
      { a: { b: [4, 5, 6] } },
    ])
  })
})
