/**
 * Shared mock factories + handler-capture harness for collector
 * host-provider tests. Each factory must be the inline literal passed
 * to `jest.mock` because `babel-plugin-jest-hoist` only allows
 * `mock`-prefixed bindings inside the hoisted factory.
 */
import type CollectorBridge from 'collector-fundamentals/bridge'
import { type Layer } from 'effect'
import type * as EffectModule from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type * as React from 'react'
import type { ReactElement } from 'react'

/**
 * Derived from {@link CollectorBridge.Host.InboundSchemas} so the
 * captured-handler shape stays in lockstep with the bridge schema —
 * adding/renaming a Web→Host tag fails the type-checker here rather
 * than at test-execution time.
 */
type CapturedHandlers = MessageHandler.HandlersFor<typeof CollectorBridge.Host.InboundSchemas>

interface MockHarness {
  routerPush: jest.Mock
  routerBack: jest.Mock
  lastHandlers: CapturedHandlers | null
}

declare global {
  // `var` is required inside `declare global` for module-augmenting
  // a `globalThis` property — the linter knows.
  // oxlint-disable-next-line no-underscore-dangle
  var __mockCollectorExpoHostProviderHarness: MockHarness | undefined
}

// oxlint-disable-next-line no-underscore-dangle
const harness: MockHarness = (globalThis.__mockCollectorExpoHostProviderHarness ??= {
  routerPush: jest.fn(),
  routerBack: jest.fn(),
  lastHandlers: null,
})

// ===========================================================================
// jest.mock factories — see file-level comment for the `mock` prefix reason.
// ===========================================================================

/** Stub for `expo-router` — indirects through the shared harness `Mock`s. */
const mockBuildExpoRouterFactory = (): unknown => ({
  useRouter: (): { push: jest.Mock; back: jest.Mock } => ({
    push: harness.routerPush,
    back: harness.routerBack,
  }),
})

/** Stub for `browser-sniffer-expo` — `react-native-webview` won't load under Jest. */
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

/** Stub for `expo-tundraish` — the real barrel pulls in `react-native-reanimated`. */
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
 * Stub for `collector-fundamentals/bridge` — captures the handlers
 * passed to `CollectorBridge.Host.ReceiverLayer` so tests can fire
 * them directly. The mock's `ReceiverLayer` returns a
 * `Layer.Layer<MessageHandler.TagId<'Collector', 'Host'>>` so it
 * remains drop-in compatible with production wiring.
 */
interface MockedCollectorBridgeModule {
  readonly __esModule: true
  readonly default: {
    readonly Host: {
      readonly ReceiverLayer: (
        handlers: CapturedHandlers
      ) => Layer.Layer<MessageHandler.TagId<'Collector', 'Host'>>
    }
  }
}
const mockBuildCollectorBridgeFactory = (): MockedCollectorBridgeModule => {
  const { Effect, Layer } = jest.requireActual<typeof EffectModule>('effect')
  return {
    __esModule: true,
    default: {
      Host: {
        ReceiverLayer: (
          handlers: CapturedHandlers
        ): Layer.Layer<MessageHandler.TagId<'Collector', 'Host'>> => {
          harness.lastHandlers = handlers
          // The production ReceiverLayer stores handlers into
          // `Host.HandlerTag`; routing-mock tests capture rather
          // than serve from the tag, so a no-op discard layer
          // suffices for the routing-side test surface.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- intentional fake-out: the discard layer satisfies the tag's structural shape but doesn't bind the phantom Id, which is fine for routing-side capture tests
          return Layer.effectDiscard(Effect.void) as Layer.Layer<
            MessageHandler.TagId<'Collector', 'Host'>
          >
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
