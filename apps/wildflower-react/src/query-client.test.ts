import { describe, expect, it, vi } from 'vite-plus/test'

import {
  asFiberFailure,
  insufficientScopeBody,
  responseErrorWithStatus,
} from './auth-error-fixtures.ts'
import { buildQueryClient } from './query-client.ts'

describe('buildQueryClient unauthorized redirect', () => {
  it('invokes onUnauthorized when a query ends in a 401', async () => {
    // Arrange
    const onUnauthorized = vi.fn()
    const queryClient = buildQueryClient(onUnauthorized)
    const wrapped = await asFiberFailure(responseErrorWithStatus(401))

    // Act — mirror a rejected authed queryFn.
    await queryClient
      .fetchQuery({
        queryKey: ['unauthorized'],
        queryFn: () => Promise.reject(wrapped),
        retry: false,
      })
      .catch(() => undefined)

    // Assert
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('does not invoke onUnauthorized for a non-401 failure', async () => {
    // Arrange
    const onUnauthorized = vi.fn()
    const queryClient = buildQueryClient(onUnauthorized)
    const wrapped = await asFiberFailure(responseErrorWithStatus(500))

    // Act
    await queryClient
      .fetchQuery({
        queryKey: ['server-error'],
        queryFn: () => Promise.reject(wrapped),
        retry: false,
      })
      .catch(() => undefined)

    // Assert
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('skips TanStack retry for a 401 or a 403 but keeps the default count for other errors', async () => {
    // Arrange
    const queryClient = buildQueryClient(() => undefined)
    const retry = queryClient.getDefaultOptions().queries?.retry
    const wrapped401 = await asFiberFailure(responseErrorWithStatus(401))
    const wrapped403 = await asFiberFailure(insufficientScopeBody)
    const wrapped500 = await asFiberFailure(responseErrorWithStatus(500))

    // Assert — 401 and 403 (deterministic authz): never; others: the default
    // three attempts.
    expect(typeof retry).toBe('function')
    if (typeof retry === 'function') {
      expect(retry(0, wrapped401)).toBe(false)
      expect(retry(0, wrapped403)).toBe(false)
      expect(retry(0, wrapped500)).toBe(true)
      expect(retry(3, wrapped500)).toBe(false)
    }
  })
})
