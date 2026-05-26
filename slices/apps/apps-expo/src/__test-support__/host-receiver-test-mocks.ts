// oxlint-disable typescript/consistent-type-imports
/**
 * Shared mock factories + fake-store harness used by the apps-expo host
 * receiver test split. Both `host-receiver-layer.test.ts` (ReceiverLayer
 * surface) and `commit-and-await-tunnel.test.ts` (helper behavior)
 * register the same three module mocks against the same `globalThis`-
 * keyed harness; centralising the wiring keeps them in lockstep.
 *
 * ## Why the `mock` prefix
 *
 * Each consumer calls `jest.mock(path, mockBuild*Factory)`. Jest's
 * babel-plugin hoists `jest.mock(...)` above the imports — referencing
 * an imported binding inside the factory only works if the binding name
 * starts with `mock` (jest's escape-hatch from its temporal-dead-zone
 * check). That's why every factory export here is `mockBuild*`.
 *
 * ## Why `globalThis`-keyed state
 *
 * The factories run during ESM-import hoisting — before any
 * module-top `const`/`let`/`var` assignment — so a plain top-level
 * reference inside the factory would still be in TDZ. `globalThis` is
 * initialised before any user code runs, so the harness object lives
 * there and the test-file-local `harness` const just reads it.
 */
import type { Context, Layer } from 'effect'

interface FakeStoreService {
  readonly commit: jest.Mock
  readonly query: jest.Mock
  readonly subscribe: jest.Mock
}

interface MockHarness {
  tunnelConfigSet?: jest.Mock
  current$Sentinel?: symbol
  tunnelStoreTag?: Context.Tag<FakeStoreService, FakeStoreService>
  lastHandlers?: {
    // oxlint-disable-next-line typescript/consistent-type-imports
    readonly RequestTunnel: () => import('effect').Effect.Effect<void>
  } | null
  sentMessages?: Array<
    | { readonly _tag: 'TunnelStarted'; readonly origin: string }
    | { readonly _tag: 'TunnelFailed'; readonly reason: string }
  >
}

const MOCK_HARNESS_KEY = '__mockAppsExpoHarness'

/** Read (creating on first access) the singleton harness. */
const harness = ((): MockHarness => {
  // `globalThis` doesn't structurally overlap with the index-signature
  // shape we want, so the cast routes through `unknown`. The cast is a
  // test-only escape hatch and `MOCK_HARNESS_KEY` is the single source
  // of truth shared with the factories below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const g = globalThis as unknown as Record<string, MockHarness | undefined>
  const existing = g[MOCK_HARNESS_KEY]
  if (existing !== undefined) return existing
  const fresh: MockHarness = {}
  g[MOCK_HARNESS_KEY] = fresh
  return fresh
})()

/** Snapshot shape the production code reads off `TunnelState.queries.current$`. */
interface TunnelStateSnapshot {
  readonly running: boolean
  readonly currentSubdomain: string | null
  readonly currentRootDomain: string | null
  readonly currentLocalPort: number | null
  readonly error: string | null
}

const EMPTY_STATE: TunnelStateSnapshot = {
  running: false,
  currentSubdomain: null,
  currentRootDomain: null,
  currentLocalPort: null,
  error: null,
}

interface FakeStoreOptions {
  readonly initialState?: TunnelStateSnapshot
}

interface FakeStore extends FakeStoreService {
  readonly pushState: (state: TunnelStateSnapshot) => void
  readonly subscriberCount: () => number
  readonly unsubscribeCalls: () => number
}

const currentSentinel = (): symbol => {
  const s = harness.current$Sentinel
  if (s === undefined) throw new Error('current$Sentinel not yet initialized')
  return s
}

const makeFakeStore = ({ initialState = EMPTY_STATE }: FakeStoreOptions = {}): FakeStore => {
  let state: TunnelStateSnapshot = initialState
  const subscribers: Array<(s: TunnelStateSnapshot) => void> = []
  let unsubscribeCalled = 0

  return {
    commit: jest.fn(),
    query: jest.fn((query: unknown) => {
      if (query !== currentSentinel()) throw new Error('unexpected query identity')
      return state
    }),
    subscribe: jest.fn((query: unknown, cb: (s: TunnelStateSnapshot) => void) => {
      if (query !== currentSentinel()) throw new Error('unexpected query identity')
      subscribers.push(cb)
      return () => {
        unsubscribeCalled += 1
        const idx = subscribers.indexOf(cb)
        if (idx >= 0) subscribers.splice(idx, 1)
      }
    }),
    pushState: (next: TunnelStateSnapshot): void => {
      state = next
      // Snapshot the subscriber list before iterating so an
      // unsubscribe-during-callback can't shift the loop's indices.
      const snapshot = Array.from(subscribers)
      for (const cb of snapshot) cb(next)
    },
    subscriberCount: () => subscribers.length,
    unsubscribeCalls: () => unsubscribeCalled,
  }
}

const requireTunnelStoreTag = (): Context.Tag<FakeStoreService, FakeStoreService> => {
  const tag = harness.tunnelStoreTag
  if (tag === undefined) throw new Error('TunnelStore tag not yet built (mock factory not run)')
  return tag
}

// ===========================================================================
// jest.mock factories — see file-level comment for the `mock` prefix reason.
// ===========================================================================

/**
 * Factory for `jest.mock('tunnel-core/livestore', mockBuildTunnelCoreFactory)`.
 * Stubs the three symbols the production code reaches for: `TunnelStore`
 * (a structurally-fake `Context.Tag`), `TunnelConfig.events.tunnelConfigSet`
 * (indirects through `harness.tunnelConfigSet` so each test can install a
 * fresh `jest.fn` and inspect calls), and `TunnelState.queries.current$`
 * (an opaque sentinel used only for identity checks inside the fake
 * store).
 */
const mockBuildTunnelCoreFactory = (): unknown => {
  const effect = jest.requireActual<{ Context: typeof Context }>('effect')
  // Re-derive the harness object from globalThis — the import-level
  // `harness` may not be initialised when this runs during ESM hoisting.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const g = globalThis as unknown as Record<string, MockHarness | undefined>
  const mockHarness = (g[MOCK_HARNESS_KEY] ??= {} as MockHarness)
  const tag = effect.Context.GenericTag<FakeStoreService, FakeStoreService>('TunnelStore')
  const sentinel = Symbol('TunnelState.current$')
  mockHarness.tunnelStoreTag = tag
  mockHarness.current$Sentinel = sentinel
  const tunnelConfigSet = (
    args: {
      readonly subdomain?: string | null
      readonly rootDomain?: string | null
      readonly requestedRunning?: boolean
    } = {}
  ): unknown => {
    const fn = mockHarness.tunnelConfigSet
    if (fn === undefined) throw new Error('tunnelConfigSet mock accessed before initialization')
    return fn(args)
  }
  return {
    __esModule: true,
    TunnelStore: tag,
    TunnelConfig: { events: { tunnelConfigSet } },
    TunnelState: { queries: { current$: sentinel } },
  }
}

/**
 * Factory for `jest.mock('shared-structures-core/livestore', mockBuildSharedStructuresFactory)`.
 * The real barrel re-exports `defineSliceLivestore`, which loads
 * `@livestore/livestore` — whose ESM output trips Jest's CJS resolver.
 * Inlines a behavior-equivalent copy of `subscribeUntil` so the
 * `@livestore/livestore` import never runs under jest. Matches the
 * production `predicate`-overload semantics; the `refinement` overload
 * is structurally identical at runtime and the type-narrowing only
 * exists at compile time, so no separate branch is needed here.
 */
const mockBuildSharedStructuresFactory = (): unknown => {
  const { Effect } = jest.requireActual<typeof import('effect')>('effect')
  const subscribeUntil = <A>(
    store: {
      query: (q: unknown) => A
      subscribe: (q: unknown, cb: (v: A) => void) => () => void
    },
    query: unknown,
    predicate: (value: A) => boolean
  ): import('effect').Effect.Effect<A> =>
    Effect.suspend(() => {
      const current = store.query(query)
      if (predicate(current)) return Effect.succeed(current)
      return Effect.async<A>((resume) => {
        let resumed = false
        const unsubscribe = store.subscribe(query, (value) => {
          if (resumed || !predicate(value)) return
          resumed = true
          unsubscribe()
          resume(Effect.succeed(value))
        })
        return Effect.sync(() => {
          if (!resumed) {
            resumed = true
            unsubscribe()
          }
        })
      })
    })
  return { __esModule: true, subscribeUntil }
}

/**
 * Factory for `jest.mock('apps-core/bridge', mockBuildAppsCoreFactory)`.
 * Captures the handlers record passed to `AppsBridge.Host.ReceiverLayer`
 * so the dispatch tests can invoke `RequestTunnel` directly without
 * standing up a transport. Replies are recorded via the `senderRef`
 * the test passes into `ReceiverLayer(senderRef)` — not via a bridge-
 * level `send` mock — since main routes host→web sends through the
 * captured `onTransportReady` sender rather than the bridge namespace.
 */
const mockBuildAppsCoreFactory = (): unknown => {
  const { Effect, Layer } = jest.requireActual<typeof import('effect')>('effect')
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const g = globalThis as unknown as Record<string, MockHarness | undefined>
  const mockHarness = (g[MOCK_HARNESS_KEY] ??= {} as MockHarness)
  return {
    __esModule: true,
    default: {
      Host: {
        ReceiverLayer: (handlers: NonNullable<MockHarness['lastHandlers']>): Layer.Layer<never> => {
          mockHarness.lastHandlers = handlers
          return Layer.effectDiscard(Effect.void)
        },
      },
    },
  }
}

/**
 * Reset the per-test mutable harness fields. Each test file should call
 * this from its own `beforeEach`.
 */
const resetHarness = (): void => {
  harness.tunnelConfigSet = jest.fn(
    (
      args: Record<string, unknown> = {}
    ): { readonly _tag: 'tunnelConfigSet'; readonly args: typeof args } => ({
      _tag: 'tunnelConfigSet',
      args,
    })
  )
  harness.lastHandlers = null
  harness.sentMessages = []
}

export {
  EMPTY_STATE,
  harness,
  makeFakeStore,
  mockBuildAppsCoreFactory,
  mockBuildSharedStructuresFactory,
  mockBuildTunnelCoreFactory,
  requireTunnelStoreTag,
  resetHarness,
}
export type { FakeStore, FakeStoreService, MockHarness, TunnelStateSnapshot }
