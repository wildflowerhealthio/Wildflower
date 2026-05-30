import { QueryClient } from '@tanstack/react-query'
import { isRedirect } from '@tanstack/react-router'
import { Layer } from 'effect'
import { DEVICE_LOGIN_PATH, NeedsSignIn, TokenTimeout } from 'gatekeeper-react'
import { describe, expect, test } from 'vite-plus/test'

import type { RouterContext } from '../router-context.ts'
import { authBeforeLoad } from './auth-gate.ts'

/**
 * Pins the `beforeLoad` auth gate's three branches: resolve → proceed,
 * `NeedsSignIn` → redirect to the device-login route, `TokenTimeout`
 * (and any other error) → rethrow so the layout's `errorComponent`
 * renders the retry screen.
 */

const makeContext = (
  awaitAuthReady: () => Promise<void>,
  transportReady: Promise<void> = Promise.resolve()
): RouterContext => ({
  queryClient: new QueryClient(),
  runAuthed: () => Promise.reject(new Error('runAuthed not used in gate tests')),
  runtimeLayer: Layer.die('runtimeLayer not used in gate tests'),
  awaitAuthReady,
  transportReady,
})

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

const makeDeferred = <T>(): Deferred<T> => {
  const box: { resolve: (value: T) => void } = { resolve: () => undefined }
  const promise = new Promise<T>((res) => {
    box.resolve = res
  })
  return { promise, resolve: (value) => box.resolve(value) }
}

describe('authBeforeLoad', () => {
  test('proceeds (resolves void) when awaitAuthReady resolves', async () => {
    const context = makeContext(() => Promise.resolve())

    await expect(authBeforeLoad({ context })).resolves.toBeUndefined()
  })

  test('redirects to the device-login route on NeedsSignIn (standalone web)', async () => {
    const context = makeContext(() => Promise.reject(new NeedsSignIn({})))

    const thrown = await authBeforeLoad({ context }).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(isRedirect(thrown)).toBe(true)
    if (isRedirect(thrown)) expect(thrown.options.to).toBe(DEVICE_LOGIN_PATH)
  })

  test('rethrows TokenTimeout (embedded) so the errorComponent renders the retry screen', async () => {
    const context = makeContext(() => Promise.reject(new TokenTimeout({})))

    await expect(authBeforeLoad({ context })).rejects.toBeInstanceOf(TokenTimeout)
  })

  test('rethrows an unexpected error rather than swallowing it into a proceed', async () => {
    const boom = new Error('boom')
    const context = makeContext(() => Promise.reject(boom))

    await expect(authBeforeLoad({ context })).rejects.toBe(boom)
  })

  test('awaits transportReady before calling awaitAuthReady', async () => {
    // The embedded entry's host pushes the bearer over the gatekeeper
    // bridge after `transport.signalReady`. The gate must therefore wait
    // for `transportReady` before `awaitAuthReady` reads the ref.
    const order: string[] = []
    const deferred = makeDeferred<void>()
    const transportReady = deferred.promise.then(() => {
      order.push('transportReady')
    })
    const awaitAuthReady = (): Promise<void> => {
      order.push('awaitAuthReady')
      return Promise.resolve()
    }
    const context = makeContext(awaitAuthReady, transportReady)

    const gate = authBeforeLoad({ context })
    // Microtask flush: without the await, the gate would already have
    // called `awaitAuthReady`. Order should still be empty.
    await Promise.resolve()
    expect(order).toEqual([])

    deferred.resolve()
    await gate

    expect(order).toEqual(['transportReady', 'awaitAuthReady'])
  })
})
