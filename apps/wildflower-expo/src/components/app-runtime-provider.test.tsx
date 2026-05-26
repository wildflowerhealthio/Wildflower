import { act, render } from '@testing-library/react-native'
import type { Context as ContextType, Effect as EffectType, Layer as LayerType } from 'effect'
import * as React from 'react'
import type { ReactElement, ReactNode } from 'react'

// Per-daemon active counters incremented by each spy Layer's
// `Effect.acquireRelease` on build and decremented on teardown. The
// assertions below pin both counts after mount, after unmount, and
// across a remount cycle to prove the merged `Layer.launch`
// dispatches *both* daemons and that each obeys React's cleanup
// contract — if a future refactor dropped either from the merge
// site, its counter would stay at 0 and the matching assertion
// would fail.
let mockHttpServerActiveCount = 0
let mockTunnelActiveCount = 0

jest.mock('../daemons/http-server.ts', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    // Same shape as production: a `Layer.scopedDiscard` whose body is
    // an `acquireRelease`. Counter tracks "this Layer is currently
    // built and not yet torn down."
    HttpServerDaemonLive: effect.Layer.scopedDiscard(
      effect.Effect.acquireRelease(
        effect.Effect.sync(() => {
          mockHttpServerActiveCount += 1
        }),
        () =>
          effect.Effect.sync(() => {
            mockHttpServerActiveCount -= 1
          })
      )
    ),
  }
})

jest.mock('tunnel-expo', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    TunnelDaemon: effect.Layer.scopedDiscard(
      effect.Effect.acquireRelease(
        effect.Effect.sync(() => {
          mockTunnelActiveCount += 1
        }),
        () =>
          effect.Effect.sync(() => {
            mockTunnelActiveCount -= 1
          })
      )
    ),
  }
})

jest.mock('tunnel-core/livestore', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    TunnelStore: {
      layerFrom: (_store: unknown) => effect.Layer.effectDiscard(effect.Effect.void),
    },
  }
})

jest.mock('local-http-server-core/livestore', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    LocalHttpServerStore: {
      layerFrom: (_store: unknown) => effect.Layer.effectDiscard(effect.Effect.void),
    },
  }
})

const mockStore = { __brand: 'mock-store' } as const

jest.mock('../livestore/livestore-store.ts', () => {
  const effect = jest.requireActual<{ Context: typeof ContextType }>('effect')
  class MockWildflowerStore extends effect.Context.Tag('wildflower-expo/WildflowerStore')<
    MockWildflowerStore,
    typeof mockStore
  >() {}
  return {
    useWildflowerStore: (): typeof mockStore => mockStore,
    WildflowerStore: MockWildflowerStore,
  }
})

// `@livestore/react` ships native runtime code; the provider tree only
// needs the registry context to forward children, so a passthrough is
// enough for the lifecycle assertions below.
jest.mock('@livestore/react', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  // Declared inside the factory because babel-plugin-jest-hoist hoists
  // `jest.mock` calls above any non-`mock`-prefixed identifier — a
  // module-scope class would not be in scope when this body runs.
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

import { AppRuntimeProvider } from './app-runtime-provider.tsx'

beforeEach(() => {
  mockHttpServerActiveCount = 0
  mockTunnelActiveCount = 0
})

// `Effect.runFork` for `Layer.launch` schedules the fiber on the
// microtask queue, and the cleanup `Effect.runFork(Fiber.interrupt)`
// does the same — an empty `act` callback flushes both, which is the
// supported way to drain pending React + microtask work without
// resorting to `Effect.sleep`.
const flushFibers = async (): Promise<void> => {
  await act(async () => {})
}

describe('AppRuntimeProvider lifecycle', () => {
  it('mounts the merged daemon Layer exactly once on initial render', async () => {
    render(<AppRuntimeProvider>{null}</AppRuntimeProvider>)
    await flushFibers()
    expect(mockHttpServerActiveCount).toBe(1)
    expect(mockTunnelActiveCount).toBe(1)
  })

  it('tears the merged daemon Layer down on unmount', async () => {
    const { unmount } = render(<AppRuntimeProvider>{null}</AppRuntimeProvider>)
    await flushFibers()
    expect(mockHttpServerActiveCount).toBe(1)
    expect(mockTunnelActiveCount).toBe(1)
    unmount()
    await flushFibers()
    expect(mockHttpServerActiveCount).toBe(0)
    expect(mockTunnelActiveCount).toBe(0)
  })

  it('survives an unmount → remount cycle without leaking a second active daemon', async () => {
    // Models the StrictMode mount/unmount/remount sequence that the
    // production `useEffect` is designed to absorb. The first effect's
    // cleanup must release the first Layer before the second mount's
    // effect fires, so the active-daemon count never exceeds 1.
    const { unmount } = render(<AppRuntimeProvider>{null}</AppRuntimeProvider>)
    await flushFibers()
    expect(mockHttpServerActiveCount).toBe(1)
    expect(mockTunnelActiveCount).toBe(1)
    unmount()
    await flushFibers()
    expect(mockHttpServerActiveCount).toBe(0)
    expect(mockTunnelActiveCount).toBe(0)
    render(<AppRuntimeProvider>{null}</AppRuntimeProvider>)
    await flushFibers()
    expect(mockHttpServerActiveCount).toBe(1)
    expect(mockTunnelActiveCount).toBe(1)
  })
})
