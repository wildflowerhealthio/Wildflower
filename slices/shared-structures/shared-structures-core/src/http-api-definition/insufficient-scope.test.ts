import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { InsufficientScopeSchema, isInsufficientScopeBody } from './insufficient-scope.ts'

describe('InsufficientScopeSchema', () => {
  test('decodes the shared Rust wire body', async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(InsufficientScopeSchema)({
        error: 'InsufficientScope',
        missingScopes: ['wildflower/Grant.d', 'system/*.rs'],
      })
    )
    expect(decoded.error).toBe('InsufficientScope')
    expect(decoded.missingScopes).toEqual(['wildflower/Grant.d', 'system/*.rs'])
  })

  test('rejects a body whose discriminant is not InsufficientScope', async () => {
    const result = await Effect.runPromiseExit(
      Schema.decodeUnknown(InsufficientScopeSchema)({
        error: 'DatabaseNotFound',
        missingScopes: [],
      })
    )
    expect(result._tag).toBe('Failure')
  })
})

describe('isInsufficientScopeBody', () => {
  test('accepts any well-formed body regardless of the scope list', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (missingScopes) => {
        expect(isInsufficientScopeBody({ error: 'InsufficientScope', missingScopes })).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('rejects the wrong discriminant, missing fields, and non-string scopes', () => {
    expect(isInsufficientScopeBody({ error: 'Nope', missingScopes: [] })).toBe(false)
    expect(isInsufficientScopeBody({ error: 'InsufficientScope' })).toBe(false)
    expect(isInsufficientScopeBody({ missingScopes: ['x'] })).toBe(false)
    expect(isInsufficientScopeBody({ error: 'InsufficientScope', missingScopes: [1, 2] })).toBe(
      false
    )
  })

  test('rejects non-object inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined)
        ),
        (value) => {
          expect(isInsufficientScopeBody(value)).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
