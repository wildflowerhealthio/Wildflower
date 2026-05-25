// oxlint-disable typescript/consistent-type-imports
/**
 * Shared mock factories + captured-handler harness used by the collector
 * host-provider test split. `host-provider.test.tsx` covers the
 * routing-side handlers (`RequestSniffableWebView` + scheme-guard +
 * Html branch); `host-provider-control.test.tsx` covers the
 * sniffer-control-ref forwarders (`Click`, `CancelSnifferRequest`) and
 * the no-op pinners (`Open`, `SniffingComplete`).
 *
 * Both files register the same five `jest.mock` calls against the same
 * `globalThis`-keyed harness; centralising the wiring here keeps the
 * captured-handler shape and the router/sniffer stubs in lockstep.
 *
 * ## Why the `mock` prefix
 *
 * Each consumer calls `jest.mock(path, mockBuild*Factory)`. Jest's
 * babel-plugin hoists `jest.mock(...)` above the imports — referencing
 * an imported binding inside the factory only works if the binding name
 * starts with `mock`. That's why every factory export here is `mockBuild*`.
 */
import type { Effect, Layer } from 'effect'
import type { ReactElement } from 'react'
import * as React from 'react'

interface CapturedHandlers {
  readonly RequestSniffableWebView: (msg: {
    source: { _tag: string; uri?: string }
  }) => Effect.Effect<void>
  readonly CancelSnifferRequest: (msg: { id: string }) => Effect.Effect<void>
  readonly SniffingComplete: () => Effect.Effect<void>
  readonly Open: (msg: { source: unknown }) => Effect.Effect<void>
  readonly Click: (msg: { querySelector: string }) => Effect.Effect<void>
}

interface MockHarness {
  routerPush: jest.Mock
  routerBack: jest.Mock
  lastHandlers: CapturedHandlers | null
}

const MOCK_HARNESS_KEY = '__mockCollectorExpoHostProviderHarness'

const harness = ((): MockHarness => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const g = globalThis as unknown as Record<string, MockHarness | undefined>
  const existing = g[MOCK_HARNESS_KEY]
  if (existing !== undefined) return existing
  const fresh: MockHarness = {
    routerPush: jest.fn(),
    routerBack: jest.fn(),
    lastHandlers: null,
  }
  g[MOCK_HARNESS_KEY] = fresh
  return fresh
})()

// ===========================================================================
// jest.mock factories — see file-level comment for the `mock` prefix reason.
// ===========================================================================

/**
 * Factory for `jest.mock('browser-sniffer-expo', ...)`. The slice's
 * `./index.ts` transitively pulls in `browser-sniffer-expo` →
 * `react-native-webview`, which fails to initialise outside a native
 * runtime. Stubbing at the slice's source import keeps the dispatch
 * path for `CollectorModalScreen` (unused here) from taking the suite
 * down.
 */
const mockBuildBrowserSnifferExpoFactory = (): unknown => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    BrowserSnifferWebView: ReactInner.forwardRef(function MockBrowserSnifferWebView(
      props: unknown,
      _ref: unknown
    ): ReactElement {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return ReactInner.createElement('MockBrowserSnifferWebView', props as object)
    }),
  }
}

/**
 * Factory for `jest.mock('expo-tundraish', ...)`. `expo-tundraish`
 * indirectly imports `react-native-reanimated`, which trips
 * TurboModules under Jest. `CollectorModalRoute` (re-exported via the
 * slice index) uses ThemedText/ThemedView for the empty state.
 */
const mockBuildExpoTundraishFactory = (): unknown => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    Spacing: { s5: 16 },
    ThemedView: (props: { readonly children?: React.ReactNode }): ReactElement =>
      ReactInner.createElement('ThemedView', props),
    ThemedText: (props: { readonly children?: React.ReactNode }): ReactElement =>
      ReactInner.createElement('ThemedText', props),
  }
}

/**
 * Factory for `jest.mock('collector-react', ...)`. The modal screen
 * uses `useCollectorHostMessaging` to re-emit sniffer events; tests
 * here don't render the modal so the hook must throw if reached.
 */
const mockBuildCollectorReactFactory = (): unknown => ({
  useCollectorHostMessaging: (): never => {
    throw new Error('useCollectorHostMessaging should not be called in this test')
  },
})

/**
 * Factory for `jest.mock('expo-router', ...)`. `useRouter` is consumed
 * by `<HostProvider>` to push the modal route. The stub indirects
 * through `harness.routerPush` / `harness.routerBack` so each test can
 * inspect calls (and `resetHarness` can clear them between tests).
 */
const mockBuildExpoRouterFactory = (): unknown => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const g = globalThis as unknown as Record<string, MockHarness | undefined>
  const mockHarness = (g[MOCK_HARNESS_KEY] ??= {
    routerPush: jest.fn(),
    routerBack: jest.fn(),
    lastHandlers: null,
  })
  return {
    useRouter: (): { push: jest.Mock; back: jest.Mock } => ({
      push: mockHarness.routerPush,
      back: mockHarness.routerBack,
    }),
  }
}

/**
 * Factory for `jest.mock('collector-fundamentals/bridge', ...)`.
 * Captures the inbound handlers `CollectorBridge.Host.ReceiverLayer`
 * receives so tests can fire them directly without standing up a
 * transport. The mock returns a no-op Layer for the receiver tag.
 */
const mockBuildCollectorBridgeFactory = (): unknown => {
  const { Effect, Layer } = jest.requireActual<typeof import('effect')>('effect')
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const g = globalThis as unknown as Record<string, MockHarness | undefined>
  const mockHarness = (g[MOCK_HARNESS_KEY] ??= {
    routerPush: jest.fn(),
    routerBack: jest.fn(),
    lastHandlers: null,
  })
  return {
    __esModule: true,
    default: {
      Host: {
        ReceiverLayer: (handlers: CapturedHandlers): Layer.Layer<never> => {
          mockHarness.lastHandlers = handlers
          return Layer.effectDiscard(Effect.void)
        },
      },
    },
  }
}

/** Reset the per-test mutable state. Call from `beforeEach`. */
const resetHarness = (): void => {
  harness.routerPush.mockClear()
  harness.routerBack.mockClear()
  harness.lastHandlers = null
}

/** Pull the most recent handlers record captured by the mock factory. */
const requireLastHandlers = (): CapturedHandlers => {
  if (harness.lastHandlers === null) {
    throw new Error('CollectorBridge.Host.ReceiverLayer mock never captured handlers')
  }
  return harness.lastHandlers
}

export {
  harness,
  mockBuildBrowserSnifferExpoFactory,
  mockBuildCollectorBridgeFactory,
  mockBuildCollectorReactFactory,
  mockBuildExpoRouterFactory,
  mockBuildExpoTundraishFactory,
  requireLastHandlers,
  resetHarness,
}
export type { CapturedHandlers, MockHarness }
