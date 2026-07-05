import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { deepFreeze } from './index.ts'
import { numRunsFor } from './test/num-runs-for.ts'

describe('deepFreeze', () => {
  it('freezes the top-level object', () => {
    const o = { a: 1 }
    deepFreeze(o)
    expect(Object.isFrozen(o)).toBe(true)
  })

  it('freezes nested objects and arrays', () => {
    const o = { a: { b: [1, { c: 2 }] } }
    deepFreeze(o)
    expect(Object.isFrozen(o)).toBe(true)
    expect(Object.isFrozen(o.a)).toBe(true)
    expect(Object.isFrozen(o.a.b)).toBe(true)
    expect(Object.isFrozen(o.a.b[1])).toBe(true)
  })

  it('returns the same reference', () => {
    const o = { a: 1 }
    expect(deepFreeze(o)).toBe(o)
  })

  it('passes primitives through unchanged', () => {
    expect(deepFreeze('s')).toBe('s')
    expect(deepFreeze(1)).toBe(1)
    expect(deepFreeze(null)).toBeNull()
  })

  it('does not recurse into function bodies but freezes the function value', () => {
    const fn = (): number => 1
    deepFreeze(fn)
    expect(Object.isFrozen(fn)).toBe(true)
  })

  it('tolerates cycles via the already-frozen short-circuit', () => {
    type Node = { name: string; next?: Node }
    const a: Node = { name: 'a' }
    const b: Node = { name: 'b', next: a }
    a.next = b
    expect(() => deepFreeze(a)).not.toThrow()
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(b)).toBe(true)
  })

  it('prevents reassignment of own properties at runtime', () => {
    const o = { a: 1 }
    deepFreeze(o)
    // Strict mode throws on writes to frozen properties.
    expect(() => {
      o.a = 2
    }).toThrow(TypeError)
  })

  it('freezes every reachable plain object for arbitrary structures', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const frozen = deepFreeze(value)
        const seen = new WeakSet<object>()
        const walk = (v: unknown): void => {
          if (v === null || typeof v !== 'object') return
          if (seen.has(v)) return
          seen.add(v)
          expect(Object.isFrozen(v)).toBe(true)
          if (Array.isArray(v)) {
            for (const child of v) walk(child)
          } else {
            for (const [, child] of Object.entries(v)) walk(child)
          }
        }
        walk(frozen)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
