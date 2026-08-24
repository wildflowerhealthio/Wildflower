import { HttpApiError } from '@effect/platform'
import { describe, expect, it } from 'vite-plus/test'

import {
  asFiberFailure,
  insufficientScopeBody,
  responseErrorWithStatus,
} from './auth-error-fixtures.ts'
import {
  insufficientScopeFromError,
  insufficientScopeFromFailure,
  isInsufficientScopeError,
  isUnauthorizedError,
  isUnauthorizedFailure,
} from './auth-errors.ts'

describe('isUnauthorizedError', () => {
  it('is true only for a ResponseError carrying a 401', () => {
    expect(isUnauthorizedError(responseErrorWithStatus(401))).toBe(true)
    expect(isUnauthorizedError(responseErrorWithStatus(403))).toBe(false)
    expect(isUnauthorizedError(responseErrorWithStatus(500))).toBe(false)
  })

  it('is true for a typed HttpApiError.Unauthorized (a declared 401)', () => {
    // Gatekeeper's `/access` endpoints declare 401 via `RequireAuthMiddleware`,
    // so `HttpApiClient` decodes their 401s into this typed error, never a
    // `ResponseError`. The detector must catch it or the redirect/retry miss it.
    expect(isUnauthorizedError(new HttpApiError.Unauthorized())).toBe(true)
  })

  it('is false for values that are not a 401', () => {
    expect(isUnauthorizedError(new Error('boom'))).toBe(false)
    expect(isUnauthorizedError(null)).toBe(false)
    expect(isUnauthorizedError({ response: { status: 401 } })).toBe(false)
  })
})

describe('isUnauthorizedFailure', () => {
  it('unwraps a FiberFailure to recognize a wrapped 401', async () => {
    expect(isUnauthorizedFailure(await asFiberFailure(responseErrorWithStatus(401)))).toBe(true)
  })

  it('is false for a FiberFailure wrapping a non-401 ResponseError', async () => {
    expect(isUnauthorizedFailure(await asFiberFailure(responseErrorWithStatus(500)))).toBe(false)
  })

  it('is false for a FiberFailure wrapping an unrelated error', async () => {
    expect(isUnauthorizedFailure(await asFiberFailure(new Error('nope')))).toBe(false)
  })
})

describe('insufficientScopeFromError', () => {
  it('names the missing scopes for a decoded InsufficientScope body', () => {
    expect(insufficientScopeFromError(insufficientScopeBody)).toEqual({
      missingScopes: ['wildflower/Grant.d', 'system/*.rs'],
    })
    expect(isInsufficientScopeError(insufficientScopeBody)).toBe(true)
  })

  it('detects a bare 403 ResponseError but cannot name the scopes', () => {
    // An *undeclared* 403 never has its body decoded, so the authorization
    // failure is still recognised (surface renders) but with no scope names.
    expect(insufficientScopeFromError(responseErrorWithStatus(403))).toEqual({ missingScopes: [] })
    expect(isInsufficientScopeError(responseErrorWithStatus(403))).toBe(true)
  })

  it('is null for a 401, a 500, and unrelated errors', () => {
    expect(insufficientScopeFromError(responseErrorWithStatus(401))).toBeNull()
    expect(insufficientScopeFromError(responseErrorWithStatus(500))).toBeNull()
    expect(insufficientScopeFromError(new Error('boom'))).toBeNull()
    expect(insufficientScopeFromError(null)).toBeNull()
    // A look-alike that isn't the real decoded body must not match.
    expect(insufficientScopeFromError({ error: 'InsufficientScope' })).toBeNull()
  })
})

describe('insufficientScopeFromFailure', () => {
  it('unwraps a FiberFailure wrapping a decoded body and names the scopes', async () => {
    expect(insufficientScopeFromFailure(await asFiberFailure(insufficientScopeBody))).toEqual({
      missingScopes: ['wildflower/Grant.d', 'system/*.rs'],
    })
  })

  it('unwraps a FiberFailure wrapping a bare 403 ResponseError', async () => {
    expect(
      insufficientScopeFromFailure(await asFiberFailure(responseErrorWithStatus(403)))
    ).toEqual({ missingScopes: [] })
  })

  it('is null for a wrapped 401 (that path redirects, it does not surface in place)', async () => {
    expect(
      insufficientScopeFromFailure(await asFiberFailure(responseErrorWithStatus(401)))
    ).toBeNull()
  })
})
