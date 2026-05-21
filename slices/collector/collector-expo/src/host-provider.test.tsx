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

// `collector-react` exports the typed host-messaging hook the modal
// screen uses to re-emit sniffer events. The probe here doesn't render
// CollectorModalScreen, so the hook is never called — stub with a
// throw to make accidental usage loud.
jest.mock('collector-react', () => ({
  useCollectorHostMessaging: (): never => {
    throw new Error('useCollectorHostMessaging should not be called in this test')
  },
}))

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
  readonly Click: (msg: { querySelector: string }) => Effect.Effect<void>
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
      <CollectorBridgeExpo.HostProvider>
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
      <CollectorBridgeExpo.HostProvider modalPath="/custom-modal">
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
      <CollectorBridgeExpo.HostProvider>
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

  it('Click forwards to the registered snifferControlRef when a modal is mounted', () => {
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    const clicks: string[] = []
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )

    // Modal registers a sniffer-control surface on mount.
    act(() => {
      seenHosts[0].snifferControlRef.current = {
        click: (qs) => clicks.push(qs),
        cancelRequest: () => undefined,
      }
    })

    act(() => {
      Effect.runSync(mockLastHandlers!.Click({ querySelector: '#submit' }))
    })

    expect(clicks).toEqual(['#submit'])
  })

  it('Click drops silently when no modal is mounted (null ref)', () => {
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={() => undefined} />
      </CollectorBridgeExpo.HostProvider>
    )

    // No registration — snifferControlRef.current stays null.
    expect(() =>
      Effect.runSync(mockLastHandlers!.Click({ querySelector: '#submit' }))
    ).not.toThrow()
  })

  it('CancelSnifferRequest forwards to the registered snifferControlRef', () => {
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    const cancels: string[] = []
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )

    act(() => {
      seenHosts[0].snifferControlRef.current = {
        click: () => undefined,
        cancelRequest: (id) => cancels.push(id),
      }
    })

    act(() => {
      Effect.runSync(mockLastHandlers!.CancelSnifferRequest({ id: 'req-1' }))
    })

    expect(cancels).toEqual(['req-1'])
  })
})
