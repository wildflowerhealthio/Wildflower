/**
 * Shared mock factories + fake-store harness used by the apps-expo host
 * receiver test split. Both `host-handlers.test.ts` (handler-record
 * dispatch) and `commit-and-await-tunnel.test.ts` (helper behavior)
 * register the same three module mocks against the same `globalThis`-
 * keyed harness; centralising the wiring keeps them in lockstep.
 *
 * See `docs/Testing/Jest Mock Harness How-To.md` for the mock-prefix +
 * globalThis-keyed-state pattern this file uses.
 */
import type { AppsBridge } from 'apps-core/bridge'
import type { Context } from 'effect'
import type { Message } from 'effect-messaging-core'

interface FakeStoreService {
  readonly commit: jest.Mock
  readonly query: jest.Mock
  readonly subscribe: jest.Mock
}

type AppsHostToWebMessage = Message.Of<AppsBridge['HostToWeb']>

interface MockHarness {
  tunnelConfigSet?: jest.Mock
  current$Sentinel?: symbol
  tunnelStoreTag?: Context.Tag<FakeStoreService, FakeStoreService>
  sentMessages: Array<AppsHostToWebMessage>
}

declare global {
  var wfMockAppsExpoHarness: MockHarness | undefined
}

const freshHarness = (): MockHarness => ({ sentMessages: [] })

/** Read (creating on first access) the singleton harness. */
const harness: MockHarness = (() => {
  const existing = globalThis.wfMockAppsExpoHarness
  if (existing !== undefined) return existing
  const fresh = freshHarness()
  globalThis.wfMockAppsExpoHarness = fresh
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

/**
 * Resolve once {@link FakeStore.subscriberCount} reaches 1, polling
 * the microtask queue. Replaces empirical `await Promise.resolve()`
 * ladders that try to nudge `Effect.async` past the point where its
 * subscriber is installed.
 */
const awaitSubscriberInstalled = async (
  store: FakeStore,
  opts: { readonly timeoutMs?: number } = {}
): Promise<void> => {
  const timeoutMs = opts.timeoutMs ?? 100
  const start = Date.now()
  while (store.subscriberCount() < 1) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Subscriber not installed within ${timeoutMs}ms`)
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential polling is the point
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
  }
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
  const mockHarness = (globalThis.wfMockAppsExpoHarness ??= freshHarness())
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
 * Factory for `jest.mock('@livestore/livestore', mockBuildLivestoreBaseFactory)`.
 *
 * `shared-structures-core/livestore` re-exports the real `subscribeUntil`
 * (which only takes `type` imports from `@livestore/livestore`), but its
 * sibling exports (`defineSliceLivestore`, `composeLivestoreModules`)
 * pull `State` and `makeSchema` as runtime values. Stubbing the whole
 * `@livestore/livestore` module to `{}` is enough to let Jest's CJS
 * resolver load the barrel without tripping on `@livestore/livestore`'s
 * ESM output — the production code under test never calls the
 * functions that need the real `State` / `makeSchema`.
 */
const mockBuildLivestoreBaseFactory = (): unknown => ({ __esModule: true })

/**
 * Factory for `jest.mock('apps-core/bridge', mockBuildAppsCoreFactory)`.
 *
 * The production handler no longer references `AppsBridge` as a runtime
 * value — `makeAppsHostHandlers` uses it in type positions only and
 * replies through the host→web `reply` sender passed to it. So this stub
 * just satisfies the import; tests record replies by passing a capturing
 * `reply` (which pushes into `harness.sentMessages`) rather than mocking a
 * bridge-level `send`. Mocking still avoids pulling the real cross-package
 * `apps-core/bridge` (and its `dist`) under Jest.
 */
const mockBuildAppsCoreFactory = (): unknown => ({
  __esModule: true,
  AppsBridge: {},
})

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
  harness.sentMessages = []
}

export {
  awaitSubscriberInstalled,
  harness,
  makeFakeStore,
  mockBuildAppsCoreFactory,
  mockBuildLivestoreBaseFactory,
  mockBuildTunnelCoreFactory,
  requireTunnelStoreTag,
  resetHarness,
}
export type { AppsHostToWebMessage, FakeStore, FakeStoreService, MockHarness, TunnelStateSnapshot }
