import { QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import type { RouterContext } from '../router-context.ts'

/**
 * Pins the embedded `UIReady` emit timing: the message must fire only
 * AFTER `prefetchKeyRoutes` settles (success OR error), and exactly once
 * per gate-pass. The prefetch is mocked to a controllable deferred so
 * the "not before settle" ordering is observable.
 */

const { prefetchDeferred, prefetchKeyRoutesMock } = vi.hoisted(() => {
  const holder: { settle: () => void } = { settle: () => undefined }
  const promise = new Promise<void>((resolve) => {
    holder.settle = resolve
  })
  return {
    prefetchDeferred: { promise, settle: () => holder.settle() },
    prefetchKeyRoutesMock: vi.fn(() => promise),
  }
})

vi.mock('./prefetch-key-routes.ts', () => ({
  prefetchKeyRoutes: prefetchKeyRoutesMock,
}))

const { sentMessages } = vi.hoisted(() => ({
  sentMessages: [] as { readonly _tag: string }[],
}))

vi.mock('./transport-context.ts', () => ({
  // The emitter only reads `sendMessage`; record what it posts.
  useBridgeTransport: () => ({
    sendMessage: (message: { readonly _tag: string }) =>
      Effect.sync(() => {
        sentMessages.push(message)
      }),
  }),
}))

const { UIReadyEmitter } = await import('./ui-ready-emitter.tsx')

const renderEmitter = (): void => {
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: UIReadyEmitter })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    context: {
      queryClient: new QueryClient(),
      runAuthed: () => Promise.reject(new Error('runAuthed not used here')),
      runtimeLayer: Layer.die('runtimeLayer not used here'),
      awaitAuthReady: () => Promise.resolve(),
      transportReady: Promise.resolve(),
    },
  })
  render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  sentMessages.length = 0
  prefetchKeyRoutesMock.mockClear()
})

describe('UIReadyEmitter', () => {
  test('warms the startup prefetch on mount', async () => {
    renderEmitter()
    await waitFor(() => expect(prefetchKeyRoutesMock).toHaveBeenCalled())
  })

  test('emits UIReady only after the prefetch settles', async () => {
    renderEmitter()
    await waitFor(() => expect(prefetchKeyRoutesMock).toHaveBeenCalled())

    // Prefetch still in-flight: nothing emitted yet.
    expect(sentMessages).toHaveLength(0)

    // Settle the prefetch → the emitter posts UIReady.
    await act(async () => {
      prefetchDeferred.settle()
      await prefetchDeferred.promise
    })

    await waitFor(() => {
      expect(sentMessages).toContainEqual({ _tag: 'UIReady' })
    })
  })
})
