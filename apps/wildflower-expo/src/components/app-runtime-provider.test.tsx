import { render, waitFor } from '@testing-library/react-native'
import type { Context as ContextType, Layer as LayerType } from 'effect'
import * as React from 'react'
import type { ReactElement, ReactNode } from 'react'

// Drives the mocked store's `requestedRunning`. `mock`-prefixed so
// babel-plugin-jest-hoist allows the `jest.mock` factories below to close
// over it.
let mockRequestedRunning = true

// Stateful stand-in for the native `react-native-background-actions`
// singleton. `start`/`stop` flip `running` so `isRunning()` mirrors the
// real module's contract, which the serialising controller reads to decide
// whether a reconcile step should start or stop.
jest.mock('react-native-background-actions', () => {
  const state = { running: false }
  return {
    __esModule: true,
    default: {
      isRunning: () => state.running,
      start: jest.fn(async () => {
        state.running = true
      }),
      stop: jest.fn(async () => {
        state.running = false
      }),
      on: jest.fn(),
      removeListener: jest.fn(),
    },
  }
})

// The merged daemon layer is built inside the hook's `useMemo` but only
// forked inside the background task — which the mocked `start` never
// invokes — so empty layers are enough to let the build succeed.
jest.mock('../daemons/http-server.ts', () => {
  const effect = jest.requireActual<{ Layer: typeof LayerType }>('effect')
  return { HttpServerDaemonLive: effect.Layer.empty }
})

jest.mock('tunnel-expo', () => {
  const effect = jest.requireActual<{ Layer: typeof LayerType }>('effect')
  return { TunnelDaemon: effect.Layer.empty }
})

jest.mock('tunnel-core/livestore', () => {
  const effect = jest.requireActual<{ Layer: typeof LayerType }>('effect')
  return {
    TunnelStore: { layerFrom: (_store: unknown) => effect.Layer.empty },
  }
})

jest.mock('local-http-server-core/livestore', () => {
  const effect = jest.requireActual<{ Layer: typeof LayerType }>('effect')
  return {
    LocalHttpServerStore: { layerFrom: (_store: unknown) => effect.Layer.empty },
    // The hook reads `requestedRunning` via `store.useQuery(current$)`; the
    // mock store ignores the query arg, so any sentinel works here.
    ServerState: { queries: { current$: { __brand: 'current$' } } },
  }
})

jest.mock('../livestore/livestore-store.ts', () => {
  const effect = jest.requireActual<{ Context: typeof ContextType }>('effect')
  class MockWildflowerStore extends effect.Context.Tag('WildflowerStore')<
    MockWildflowerStore,
    unknown
  >() {}
  // Stable handle across rerenders so `useMemo([store])` keeps one runtime.
  const store = { useQuery: () => ({ requestedRunning: mockRequestedRunning }) }
  return {
    useWildflowerStore: () => store,
    wildflowerStoreRegistry: {},
    WildflowerStore: MockWildflowerStore,
  }
})

// `@livestore/react` ships native runtime code; the provider tree only
// needs the registry context to forward children.
jest.mock('@livestore/react', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  // oxlint-disable-next-line typescript/no-extraneous-class
  class MockStoreRegistry {}
  return {
    StoreRegistry: MockStoreRegistry,
    StoreRegistryProvider: function MockStoreRegistryProvider(props: {
      readonly children: ReactNode
    }): ReactElement {
      return ReactInner.createElement(ReactInner.Fragment, null, props.children)
    },
  }
})

import BackgroundService from 'react-native-background-actions'
import AppRuntimeProvider from './app-runtime-provider.tsx'

// `jest.mocked` is the canonical typed accessor for a mocked function and
// avoids the unsafe-narrowing `as jest.Mock` cast. The `unbound-method`
// rule misfires here because we never invoke the method — we only read
// `.mock.calls` / `.mockClear` off the mock state, which lives on the
// function reference itself.
// oxlint-disable-next-line typescript/unbound-method
const start = jest.mocked(BackgroundService.start)
// oxlint-disable-next-line typescript/unbound-method
const stop = jest.mocked(BackgroundService.stop)

// Flush the controller's promise-chained reconciles (one macrotask tick
// drains the queued microtasks).
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  start.mockClear()
  stop.mockClear()
  mockRequestedRunning = true
})

afterEach(async () => {
  // Let the unmount-driven `stop` reconcile settle so module-singleton
  // controller state doesn't leak into the next test.
  await flush()
})

describe('AppRuntimeProvider background-server lifecycle', () => {
  // Declared first so it runs against pristine module-singleton reconciler
  // state. Under StrictMode React double-invokes the effect (setup → cleanup
  // → setup); the serialising reconciler must collapse that burst to a single
  // start rather than launching — and binding the port — twice.
  it('starts the service exactly once under StrictMode double-invoke', async () => {
    render(
      <React.StrictMode>
        <AppRuntimeProvider>{null}</AppRuntimeProvider>
      </React.StrictMode>
    )
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(BackgroundService.isRunning()).toBe(true)
  })

  it('starts the background service once on mount when requestedRunning is true', async () => {
    render(<AppRuntimeProvider>{null}</AppRuntimeProvider>)
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(BackgroundService.isRunning()).toBe(true)
  })

  it('does not start the service on mount when requestedRunning is false', async () => {
    mockRequestedRunning = false
    render(<AppRuntimeProvider>{null}</AppRuntimeProvider>)
    await flush()
    expect(start).not.toHaveBeenCalled()
    expect(BackgroundService.isRunning()).toBe(false)
  })

  it('stops the background service on unmount', async () => {
    const { unmount } = render(<AppRuntimeProvider>{null}</AppRuntimeProvider>)
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    unmount()
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    expect(BackgroundService.isRunning()).toBe(false)
  })

  it('stops when requestedRunning flips to false and restarts when it flips back', async () => {
    const { rerender } = render(<AppRuntimeProvider>{null}</AppRuntimeProvider>)
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))

    mockRequestedRunning = false
    rerender(<AppRuntimeProvider>{null}</AppRuntimeProvider>)
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    expect(BackgroundService.isRunning()).toBe(false)

    mockRequestedRunning = true
    rerender(<AppRuntimeProvider>{null}</AppRuntimeProvider>)
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(BackgroundService.isRunning()).toBe(true)
  })
})
