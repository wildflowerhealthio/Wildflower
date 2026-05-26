// oxlint-disable typescript/consistent-type-imports
/**
 * Shared mock factories + captured-handler harness used by the
 * collector host-provider test split. `host-provider.test.tsx`
 * covers the routing-side handlers (`RequestSniffableWebView` +
 * `Open` + `SniffingComplete` + scheme-guard + Html branch);
 * `host-provider-control.test.tsx` covers the sniffer-control
 * forwarders (`Click`, `CancelSnifferRequest`) by capturing the
 * sender registered through {@link useAsMessageSenderToBrowserSniffer}.
 *
 * Both files register the same `jest.mock` calls against the same
 * `globalThis`-keyed harness; centralising the wiring here keeps
 * the captured-handler shape, router stubs, and the heavy native
 * deps (browser-sniffer-expo + expo-tundraish, pulled in via
 * `./index.ts` because it re-exports the modal screen) in lockstep.
 *
 * ## Why the `mock` prefix
 *
 * Each consumer calls `jest.mock(path, mockBuild*Factory)`. Jest's
 * babel-plugin hoists `jest.mock(...)` above the imports —
 * referencing an imported binding inside the factory only works if
 * the binding name starts with `mock`. That's why every factory
 * export here is `mockBuild*`.
 */
import type CollectorBridge from 'collector-fundamentals/bridge'
import type { Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import * as React from 'react'
import type { ReactElement } from 'react'

/**
 * Derived from {@link CollectorBridge.Host.InboundSchemas} so the
 * captured-handler shape stays in lockstep with the bridge schema —
 * adding/renaming a Web→Host tag fails the type-checker here rather
 * than at test-execution time. Mirrors `SnifferHandlers` in
 * `browser-sniffer-expo`.
 */
type CapturedHandlers = MessageHandler.HandlersFor<typeof CollectorBridge.Host.InboundSchemas>

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
 * Factory for `jest.mock('expo-router', ...)`. `useRouter` is
 * consumed by `<HostProvider>` (via `useReceiverLayer`) to push the
 * modal route and pop it on `SniffingComplete`. The stub indirects
 * through `harness.routerPush` / `harness.routerBack` so each test
 * can inspect calls (and `resetHarness` can clear them between
 * tests).
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
 * Factory for `jest.mock('browser-sniffer-expo', ...)`. The slice's
 * `./index.ts` re-exports `CollectorModalScreen`, which imports
 * `BrowserSnifferWebView` → `react-native-webview`, which fails to
 * initialise outside a native runtime. Stubbed here so the routing
 * tests can `import { CollectorBridgeExpo } from './index.ts'`
 * without dragging the native module in.
 */
const mockBuildBrowserSnifferExpoFactory = (): unknown => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    BrowserSnifferWebView: ReactInner.forwardRef(function MockBrowserSnifferWebView(
      _props: unknown,
      _ref: unknown
    ): ReactElement {
      return ReactInner.createElement('MockBrowserSnifferWebView', null)
    }),
  }
}

/**
 * Factory for `jest.mock('expo-tundraish', ...)`. The screen + route
 * use `ThemedView` / `ThemedText`; the real barrel pulls in
 * `react-native-reanimated` which trips TurboModules under Jest.
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
  mockBuildExpoRouterFactory,
  mockBuildExpoTundraishFactory,
  requireLastHandlers,
  resetHarness,
}
export type { CapturedHandlers, MockHarness }
