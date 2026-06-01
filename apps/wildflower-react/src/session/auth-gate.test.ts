import { QueryClient } from '@tanstack/react-query'
import { isRedirect, redirect } from '@tanstack/react-router'
import { Effect, Layer } from 'effect'
import { TokenTimeout } from 'gatekeeper-react'
import { describe, expect, test } from 'vite-plus/test'

import type { RouterContext } from '../router-context.ts'
import { authBeforeLoad } from './auth-gate.ts'

/**
 * Pins the `beforeLoad` auth gate's three branches: resolve → proceed,
 * `redirect(...)` → bubble so TanStack follows the redirect to the
 * device-login route, `TokenTimeout` (and any other error) → bubble so
 * the layout's `errorComponent` renders the retry screen.
 *
 * Also pins the `FiberFailure` unwrap: a `TokenTimeout` routed through
 * the Effect runtime's defect path arrives wrapped in a `FiberFailure`
 * whose `.cause` carries the underlying tagged failure. The gate must
 * surface the unwrapped value so downstream `instanceof TokenTimeout` /
 * `isRedirect(...)` checks fire correctly.
 */

const makeContext = (awaitAuthReady: () => Promise<void>): RouterContext => ({
  queryClient: new QueryClient(),
  runAuthed: () => Promise.reject(new Error('runAuthed not used in gate tests')),
  runtimeLayer: Layer.die('runtimeLayer not used in gate tests'),
  awaitAuthReady,
  transport: Promise.resolve({
    sendMessage: () => Effect.void,
    coordinator: { register: () => Effect.void, unregister: () => Effect.void },
  }),
})

describe('authBeforeLoad', () => {
  test('proceeds (resolves void) when awaitAuthReady resolves', async () => {
    const context = makeContext(() => Promise.resolve())

    await expect(authBeforeLoad({ context })).resolves.toBeUndefined()
  })

  test('bubbles a redirect to the device-login route (standalone web)', async () => {
    const context = makeContext(() => Promise.reject(redirect({ to: '/gatekeeper/device-login' })))

    const thrown = await authBeforeLoad({ context }).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(isRedirect(thrown)).toBe(true)
    if (isRedirect(thrown)) expect(thrown.options.to).toBe('/gatekeeper/device-login')
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

  test('unwraps a FiberFailure-wrapped TokenTimeout so the retry branch fires', async () => {
    // The Effect runtime routes some failures (timeout races + scope
    // interrupts around Stream operators) through the defect path,
    // landing as a `FiberFailure` whose `.cause` carries the typed
    // value. Drive the actual `embeddedAuthReadyEffect` shape via
    // `Effect.runPromise(Effect.die(...))` — `Die` is a defect, so
    // `runPromise` rejects with a `FiberFailure` wrapping the
    // TokenTimeout, exactly the shape the gate must unwrap.
    const tokenTimeout = new TokenTimeout({})
    const context = makeContext(() => Effect.runPromise(Effect.die(tokenTimeout)))

    const thrown = await authBeforeLoad({ context }).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(thrown).toBeInstanceOf(TokenTimeout)
  })
})
