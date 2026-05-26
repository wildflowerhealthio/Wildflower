import * as React from 'react'

import { fc, test as fcTest } from '@fast-check/jest'
import { act, render } from '@testing-library/react-native'
import type * as BrowserSnifferExpoModule from 'browser-sniffer-expo'
import type CollectorBridgeType from 'collector-fundamentals/bridge'
import type * as CollectorBridgeModule from 'collector-fundamentals/bridge'
import type * as EffectModule from 'effect'
import { Effect, type Layer } from 'effect'
import type { BridgeTransport, MessageHandler } from 'effect-messaging-core'
import type * as ExpoRouterModule from 'expo-router'
import type * as ExpoTundraishModule from 'expo-tundraish'
import { LoggingLayerTest } from 'kitchen-sink/test'
import type { ReactElement } from 'react'

// `var` is required inside `declare global` for module-augmenting a
// `globalThis` property; the leading `__` flags the slot as a private
// test-only key, both lint conventions notwithstanding.
declare global {
  // oxlint-disable-next-line no-underscore-dangle
  var __mockCollectorExpoHostProviderHarness:
    | {
        routerPush: jest.Mock
        routerBack: jest.Mock
        lastHandlers: CapturedHandlers | null
      }
    | undefined
}

type CapturedHandlers = MessageHandler.HandlersFor<typeof CollectorBridgeType.Host.InboundSchemas>

// oxlint-disable-next-line no-underscore-dangle
const mockHarness = (globalThis.__mockCollectorExpoHostProviderHarness ??= {
  routerPush: jest.fn(),
  routerBack: jest.fn(),
  lastHandlers: null,
})

// Each factory typed as `Partial<typeof import('<module>')>` so an
// upstream API change surfaces here at type-check time rather than at
// test-execution time.
jest.mock(
  'expo-router',
  (): Partial<typeof ExpoRouterModule> => ({
    useRouter: (): ReturnType<typeof ExpoRouterModule.useRouter> =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the real `useRouter` returns a `Router` interface with ~12 fields; stubbing only the two methods used by `useCollectorReceiverLayer` keeps the mock minimal.
      ({
        push: mockHarness.routerPush,
        back: mockHarness.routerBack,
      }) as unknown as ReturnType<typeof ExpoRouterModule.useRouter>,
  })
)

jest.mock(
  'collector-fundamentals/bridge',
  (): Partial<typeof CollectorBridgeModule> & { __esModule: true } => {
    const { Effect: EffectInner, Layer: LayerInner } =
      jest.requireActual<typeof EffectModule>('effect')
    return {
      __esModule: true,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the real `default` is a full `Bridge.Bridge<...>` with name, hostToWeb, webToHost, Host, Web; the routing-side tests only reach into `.Host.ReceiverLayer`.
      default: {
        Host: {
          ReceiverLayer: (
            handlers: CapturedHandlers
          ): Layer.Layer<MessageHandler.TagId<'Collector', 'Host'>> => {
            mockHarness.lastHandlers = handlers
            // The discard layer satisfies the structural shape but
            // doesn't bind the phantom Id — routing-side tests
            // capture handlers rather than resolving from the tag.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            return LayerInner.effectDiscard(EffectInner.void) as Layer.Layer<
              MessageHandler.TagId<'Collector', 'Host'>
            >
          },
        },
      } as unknown as typeof CollectorBridgeModule.default,
    }
  }
)

jest.mock('browser-sniffer-expo', (): Partial<typeof BrowserSnifferExpoModule> => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test never renders this stub; props are ignored at runtime.
    BrowserSnifferWebView: ReactInner.forwardRef(function MockBrowserSnifferWebView(
      _props: unknown,
      _ref: unknown
    ): ReactElement {
      return ReactInner.createElement('MockBrowserSnifferWebView', null)
    }) as unknown as typeof BrowserSnifferExpoModule.BrowserSnifferWebView,
  }
})

jest.mock('expo-tundraish', (): Partial<typeof ExpoTundraishModule> => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    Spacing: { s5: 16 } as unknown as typeof ExpoTundraishModule.Spacing,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    ThemedView: ((props: { readonly children?: React.ReactNode }): ReactElement =>
      ReactInner.createElement(
        'ThemedView',
        props
      )) as unknown as typeof ExpoTundraishModule.ThemedView,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    ThemedText: ((props: { readonly children?: React.ReactNode }): ReactElement =>
      ReactInner.createElement(
        'ThemedText',
        props
      )) as unknown as typeof ExpoTundraishModule.ThemedText,
  }
})

import type BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import { useCollectorHost } from './collector-host-context.tsx'
import {
  CollectorHostProvider,
  useAsBrowserSnifferSource,
  useCollectorReceiverLayer,
  type CollectorHostProviderProps,
} from './index.ts'

type SnifferSender = BridgeTransport.MessageSender<readonly [typeof BrowserSnifferBridge], 'Host'>

const requireLastHandlers = (): CapturedHandlers => {
  if (mockHarness.lastHandlers === null) {
    throw new Error('CollectorBridge.Host.ReceiverLayer mock never captured handlers')
  }
  return mockHarness.lastHandlers
}

const TestProbe = ({
  onReady,
  sender,
}: {
  readonly onReady?: (host: ReturnType<typeof useCollectorHost>) => void
  readonly sender?: SnifferSender
}): ReactElement | null => {
  // Build the layer so the receiver-layer mock captures handlers.
  useCollectorReceiverLayer()
  const host = useCollectorHost()
  useAsBrowserSnifferSource(sender ?? (() => Effect.void))
  onReady?.(host)
  return null
}

const renderProvider = (
  props: Omit<CollectorHostProviderProps, 'children'> & {
    readonly onReady?: (host: ReturnType<typeof useCollectorHost>) => void
    readonly sender?: SnifferSender
  } = {}
): { seenHosts: Array<ReturnType<typeof useCollectorHost>> } => {
  const { onReady, sender, ...providerProps } = props
  const seenHosts: Array<ReturnType<typeof useCollectorHost>> = []
  render(
    <CollectorHostProvider {...providerProps}>
      <TestProbe
        onReady={(h) => {
          seenHosts.push(h)
          onReady?.(h)
        }}
        sender={sender}
      />
    </CollectorHostProvider>
  )
  return { seenHosts }
}

beforeEach(() => {
  mockHarness.routerPush.mockClear()
  mockHarness.routerBack.mockClear()
  mockHarness.lastHandlers = null
})

describe('routing handlers (RequestSniffableWebView / Open)', () => {
  // `RequestSniffableWebView` and `Open` both call `setPendingSource`,
  // which IS a React state update — `act` is required for these.

  it('RequestSniffableWebView updates pendingSource and pushes the modal route', () => {
    const { seenHosts } = renderProvider()
    const handlers = requireLastHandlers()
    expect(seenHosts[0]?.pendingSource).toBeNull()

    act(() => {
      Effect.runSync(
        handlers.RequestSniffableWebView({
          _tag: 'RequestSniffableWebView',
          source: { _tag: 'Uri', uri: 'https://example.com' },
        })
      )
    })

    expect(mockHarness.routerPush).toHaveBeenCalledWith('/collector-modal')
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toEqual({
      _tag: 'Uri',
      uri: 'https://example.com',
    })
  })

  it('honors a custom modalPath on the provider', () => {
    renderProvider({ modalPath: '/custom-modal' })
    const handlers = requireLastHandlers()

    act(() => {
      Effect.runSync(
        handlers.RequestSniffableWebView({
          _tag: 'RequestSniffableWebView',
          source: { _tag: 'Uri', uri: 'https://example.com' },
        })
      )
    })

    expect(mockHarness.routerPush).toHaveBeenCalledWith('/custom-modal')
  })

  // The host-side defense-in-depth check in `useCollectorReceiverLayer` refuses
  // any `{_tag: 'Uri'}` URI that doesn't case-insensitively start with
  // `http(s)://`. The bridge schema already pins `Uri` to `https://`
  // only, so the branch is belt-and-suspenders — fuzz it against any
  // string that isn't `http(s)://`-prefixed (case-insensitive) so a
  // regression in the predicate fails loudly.
  fcTest.prop({
    uri: fc.string().filter((s) => !/^https?:\/\//i.test(s)),
  })('drops non-http(s) URIs without touching the router (defense-in-depth)', ({ uri }) => {
    const { seenHosts } = renderProvider()
    const handlers = requireLastHandlers()

    Effect.runSync(
      handlers.RequestSniffableWebView({
        _tag: 'RequestSniffableWebView',
        source: { _tag: 'Uri', uri },
      })
    )

    expect(mockHarness.routerPush).not.toHaveBeenCalled()
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toBeNull()
  })

  it.each([['http://example.com'], ['HTTP://example.com'], ['HtTpS://EXAMPLE.com']])(
    'accepts %s (case-insensitive http(s) scheme)',
    (uri) => {
      const { seenHosts } = renderProvider()
      const handlers = requireLastHandlers()

      act(() => {
        Effect.runSync(
          handlers.RequestSniffableWebView({
            _tag: 'RequestSniffableWebView',
            source: { _tag: 'Uri', uri },
          })
        )
      })

      expect(mockHarness.routerPush).toHaveBeenCalledWith('/collector-modal')
      expect(seenHosts[seenHosts.length - 1]?.pendingSource).toEqual({ _tag: 'Uri', uri })
    }
  )

  it('Html source bypasses the http(s) predicate and pushes the modal route', () => {
    const { seenHosts } = renderProvider()
    const handlers = requireLastHandlers()
    const htmlSource = { _tag: 'Html' as const, html: '<html><body>ok</body></html>' }

    act(() => {
      Effect.runSync(
        handlers.RequestSniffableWebView({ _tag: 'RequestSniffableWebView', source: htmlSource })
      )
    })

    expect(mockHarness.routerPush).toHaveBeenCalledWith('/collector-modal')
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toEqual(htmlSource)
  })

  it('Open re-mounts pendingSource without pushing the router (modal already open)', () => {
    const { seenHosts } = renderProvider()
    const handlers = requireLastHandlers()
    const nextSource = { _tag: 'Uri' as const, uri: 'https://example.com/step-2' }

    act(() => {
      Effect.runSync(handlers.Open({ _tag: 'Open', source: nextSource }))
    })

    expect(mockHarness.routerPush).not.toHaveBeenCalled()
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toEqual(nextSource)
  })
})

describe('sniffer-control forwarding (Click / CancelSnifferRequest)', () => {
  // `Click` and `CancelSnifferRequest` route through the pipe's
  // `Effect.suspend → handlerRef.current(msg)`. The registered probe
  // sender below is `Effect.sync(() => calls.push(msg))` — no React
  // state, so `act` is intentionally absent.

  it('Click forwards through the registered sender', async () => {
    const calls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const sender: SnifferSender = (msg) => Effect.sync(() => calls.push(msg))
    renderProvider({ sender })
    const handlers = requireLastHandlers()

    await Effect.runPromise(handlers.Click({ _tag: 'Click', querySelector: '#submit' }))

    expect(calls).toEqual([{ _tag: 'Click', querySelector: '#submit' }])
  })

  it('CancelSnifferRequest forwards through the registered sender', async () => {
    const calls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const sender: SnifferSender = (msg) => Effect.sync(() => calls.push(msg))
    renderProvider({ sender })
    const handlers = requireLastHandlers()

    await Effect.runPromise(
      handlers.CancelSnifferRequest({ _tag: 'CancelSnifferRequest', id: 'req-1' })
    )

    expect(calls).toEqual([{ _tag: 'CancelSnifferRequest', id: 'req-1' }])
  })

  it('Click routes to the warn-and-drop default when no sender is registered, logging a warning', async () => {
    // No `TestProbe` registers a sender — the pipe's default handler
    // logs a warning and succeeds.
    const NoopProbe = (): ReactElement | null => {
      useCollectorReceiverLayer()
      return null
    }
    render(
      <CollectorHostProvider>
        <NoopProbe />
      </CollectorHostProvider>
    )
    const handlers = requireLastHandlers()
    const { layer, logSink } = LoggingLayerTest.make()

    await Effect.runPromise(
      handlers.Click({ _tag: 'Click', querySelector: '#submit' }).pipe(Effect.provide(layer))
    )

    const warn = logSink.find((entry) => entry.level === 'WARN')
    expect(warn?.message).toContain('BrowserSniffer')
    expect(warn?.message).toContain('dropping')
  })
})

describe('modal lifecycle (SniffingComplete)', () => {
  // `SniffingComplete` calls `router.back()` (a mock — no React state).
  // `act` is intentionally absent.
  it('SniffingComplete calls router.back()', async () => {
    renderProvider()
    const handlers = requireLastHandlers()

    await Effect.runPromise(handlers.SniffingComplete({ _tag: 'SniffingComplete' }))

    expect(mockHarness.routerBack).toHaveBeenCalledTimes(1)
    expect(mockHarness.routerPush).not.toHaveBeenCalled()
  })
})
