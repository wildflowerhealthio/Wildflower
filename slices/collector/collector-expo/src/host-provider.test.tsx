import { act, render } from '@testing-library/react-native'
import type { Layer } from 'effect'
import { Effect } from 'effect'
import * as React from 'react'
import type { ReactElement } from 'react'

// `collector-expo`'s `./index.ts` transitively pulls in
// `browser-sniffer-expo` → `react-native-webview`, which fails to
// initialize outside a native runtime. Stubbed at the slice's source
// import so the dispatch path for `CollectorModalScreen` (unused here)
// doesn't take the suite down.
jest.mock('browser-sniffer-expo', () => {
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
})

// `expo-tundraish` indirectly imports `react-native-reanimated`, which
// trips TurboModules under Jest. The `CollectorModalRoute` re-exported
// via the slice index uses ThemedText/ThemedView for the empty state.
jest.mock('expo-tundraish', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    Spacing: { s5: 16 },
    ThemedView: (props: { readonly children?: React.ReactNode }): ReactElement =>
      ReactInner.createElement('ThemedView', props),
    ThemedText: (props: { readonly children?: React.ReactNode }): ReactElement =>
      ReactInner.createElement('ThemedText', props),
  }
})

const mockRouterPush = jest.fn()
const mockRouterBack = jest.fn()

// `useRouter` is consumed by `<HostProvider>` to push the modal
// route. The stub exposes spies so tests can assert push/back calls.
jest.mock('expo-router', () => ({
  useRouter: (): { push: typeof mockRouterPush; back: typeof mockRouterBack } => ({
    push: mockRouterPush,
    back: mockRouterBack,
  }),
}))

// Capture the inbound handlers `CollectorBridge.Host.ReceiverLayer`
// receives so the test can fire them directly without standing up a
// transport. The mock returns a no-op Layer for the receiver tag.
let mockLastHandlers: {
  readonly RequestSniffableWebView: (msg: {
    source: { _tag: string; uri?: string }
  }) => Effect.Effect<void>
  readonly CancelSnifferRequest: (msg: { id: string }) => Effect.Effect<void>
  readonly SniffingComplete: () => Effect.Effect<void>
  readonly Open: (msg: { source: unknown }) => Effect.Effect<void>
  readonly Click: () => Effect.Effect<void>
} | null = null

jest.mock('collector-fundamentals/bridge', () => {
  const effect = jest.requireActual<{ Effect: typeof Effect; Layer: typeof Layer }>('effect')
  return {
    __esModule: true,
    default: {
      Host: {
        ReceiverLayer: (handlers: NonNullable<typeof mockLastHandlers>): Layer.Layer<never> => {
          mockLastHandlers = handlers
          return effect.Layer.effectDiscard(effect.Effect.void)
        },
      },
    },
  }
})

import { CollectorBridgeExpo } from './index.ts'

const TestProbe = ({
  onReady,
}: {
  readonly onReady: (host: ReturnType<typeof CollectorBridgeExpo.useHost>) => void
}): ReactElement | null => {
  // Build the layer so the receiver-layer mock captures handlers.
  CollectorBridgeExpo.useReceiverLayer()
  const host = CollectorBridgeExpo.useHost()
  onReady(host)
  return null
}

beforeEach(() => {
  mockRouterPush.mockClear()
  mockRouterBack.mockClear()
  mockLastHandlers = null
})

describe('CollectorBridgeExpo.HostProvider + useReceiverLayer', () => {
  it('RequestSniffableWebView updates pendingSource and pushes the modal route', () => {
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    render(
      <CollectorBridgeExpo.HostProvider postRawMessage={() => undefined}>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )

    expect(mockLastHandlers).not.toBeNull()
    expect(seenHosts[0]?.pendingSource).toBeNull()

    act(() => {
      Effect.runSync(
        mockLastHandlers!.RequestSniffableWebView({
          source: { _tag: 'Uri', uri: 'https://example.com' },
        })
      )
    })

    expect(mockRouterPush).toHaveBeenCalledWith('/collector-modal')
    const lastHost = seenHosts[seenHosts.length - 1]
    expect(lastHost?.pendingSource).toEqual({ _tag: 'Uri', uri: 'https://example.com' })
  })

  it('honors a custom modalPath on the provider', () => {
    render(
      <CollectorBridgeExpo.HostProvider postRawMessage={() => undefined} modalPath="/custom-modal">
        <TestProbe onReady={() => undefined} />
      </CollectorBridgeExpo.HostProvider>
    )

    act(() => {
      Effect.runSync(
        mockLastHandlers!.RequestSniffableWebView({
          source: { _tag: 'Uri', uri: 'https://example.com' },
        })
      )
    })

    expect(mockRouterPush).toHaveBeenCalledWith('/custom-modal')
  })

  it('drops a non-http(s) URI without touching the router (defense-in-depth)', () => {
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    render(
      <CollectorBridgeExpo.HostProvider postRawMessage={() => undefined}>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )

    act(() => {
      Effect.runSync(
        mockLastHandlers!.RequestSniffableWebView({
          source: { _tag: 'Uri', uri: 'javascript:alert(1)' },
        })
      )
    })

    expect(mockRouterPush).not.toHaveBeenCalled()
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toBeNull()
  })

  it('exposes postRawMessage from the provider through the context', () => {
    const sink: string[] = []
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    render(
      <CollectorBridgeExpo.HostProvider postRawMessage={(raw) => sink.push(raw)}>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )

    seenHosts[0]?.postRawMessage('payload-A')
    expect(sink).toEqual(['payload-A'])
  })
})
