import { fc, test as fcTest } from '@fast-check/jest'
import { act, render } from '@testing-library/react-native'
import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import { LoggingLayerTest } from 'kitchen-sink/test'
import type { ReactElement } from 'react'

import {
  harness,
  mockBuildBrowserSnifferExpoFactory,
  mockBuildCollectorBridgeFactory,
  mockBuildExpoRouterFactory,
  mockBuildExpoTundraishFactory,
  requireLastHandlers,
  resetHarness,
} from './__test-support__/host-provider-test-mocks.ts'

// See `host-provider-test-mocks.ts` for why each factory is the inline
// literal passed to `jest.mock`.
jest.mock('expo-router', () => mockBuildExpoRouterFactory())
jest.mock('collector-fundamentals/bridge', () => mockBuildCollectorBridgeFactory())
jest.mock('browser-sniffer-expo', () => mockBuildBrowserSnifferExpoFactory())
jest.mock('expo-tundraish', () => mockBuildExpoTundraishFactory())

import type BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import { useCollectorHost } from './collector-host-context.tsx'
import { CollectorBridgeExpo, useAsBrowserSnifferSource, type HostProviderProps } from './index.ts'

type SnifferSender = BridgeTransport.MessageSender<readonly [typeof BrowserSnifferBridge], 'Host'>

const TestProbe = ({
  onReady,
  sender,
}: {
  readonly onReady?: (host: ReturnType<typeof useCollectorHost>) => void
  readonly sender?: SnifferSender
}): ReactElement | null => {
  // Build the layer so the receiver-layer mock captures handlers.
  CollectorBridgeExpo.useReceiverLayer()
  const host = useCollectorHost()
  useAsBrowserSnifferSource(sender ?? (() => Effect.void))
  onReady?.(host)
  return null
}

const renderProvider = (
  props: Omit<HostProviderProps, 'children'> & {
    readonly onReady?: (host: ReturnType<typeof useCollectorHost>) => void
    readonly sender?: SnifferSender
  } = {}
): { seenHosts: Array<ReturnType<typeof useCollectorHost>> } => {
  const { onReady, sender, ...providerProps } = props
  const seenHosts: Array<ReturnType<typeof useCollectorHost>> = []
  render(
    <CollectorBridgeExpo.HostProvider {...providerProps}>
      <TestProbe
        onReady={(h) => {
          seenHosts.push(h)
          onReady?.(h)
        }}
        sender={sender}
      />
    </CollectorBridgeExpo.HostProvider>
  )
  return { seenHosts }
}

beforeEach(() => {
  resetHarness()
})

describe('routing handlers (RequestSniffableWebView / Open)', () => {
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

    expect(harness.routerPush).toHaveBeenCalledWith('/collector-modal')
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

    expect(harness.routerPush).toHaveBeenCalledWith('/custom-modal')
  })

  // The host-side defense-in-depth check in `useReceiverLayer` refuses
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

    act(() => {
      Effect.runSync(
        handlers.RequestSniffableWebView({
          _tag: 'RequestSniffableWebView',
          source: { _tag: 'Uri', uri },
        })
      )
    })

    expect(harness.routerPush).not.toHaveBeenCalled()
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

      expect(harness.routerPush).toHaveBeenCalledWith('/collector-modal')
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

    expect(harness.routerPush).toHaveBeenCalledWith('/collector-modal')
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toEqual(htmlSource)
  })

  it('Open re-mounts pendingSource without pushing the router (modal already open)', () => {
    const { seenHosts } = renderProvider()
    const handlers = requireLastHandlers()
    const nextSource = { _tag: 'Uri' as const, uri: 'https://example.com/step-2' }

    act(() => {
      Effect.runSync(handlers.Open({ _tag: 'Open', source: nextSource }))
    })

    expect(harness.routerPush).not.toHaveBeenCalled()
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toEqual(nextSource)
  })
})

describe('sniffer-control forwarding (Click / CancelSnifferRequest)', () => {
  it('Click forwards through the registered sender', async () => {
    const calls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const sender: SnifferSender = (msg) => Effect.sync(() => calls.push(msg))
    renderProvider({ sender })
    const handlers = requireLastHandlers()

    await act(async () => {
      await Effect.runPromise(handlers.Click({ _tag: 'Click', querySelector: '#submit' }))
    })

    expect(calls).toEqual([{ _tag: 'Click', querySelector: '#submit' }])
  })

  it('CancelSnifferRequest forwards through the registered sender', async () => {
    const calls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const sender: SnifferSender = (msg) => Effect.sync(() => calls.push(msg))
    renderProvider({ sender })
    const handlers = requireLastHandlers()

    await act(async () => {
      await Effect.runPromise(
        handlers.CancelSnifferRequest({ _tag: 'CancelSnifferRequest', id: 'req-1' })
      )
    })

    expect(calls).toEqual([{ _tag: 'CancelSnifferRequest', id: 'req-1' }])
  })

  it('Click routes to the warn-and-drop default when no sender is registered, logging a warning', async () => {
    // No `TestProbe` registers a sender — the pipe's default handler
    // logs a warning and succeeds.
    const NoopProbe = (): ReactElement | null => {
      CollectorBridgeExpo.useReceiverLayer()
      return null
    }
    render(
      <CollectorBridgeExpo.HostProvider>
        <NoopProbe />
      </CollectorBridgeExpo.HostProvider>
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
  it('SniffingComplete calls router.back()', async () => {
    renderProvider()
    const handlers = requireLastHandlers()

    await act(async () => {
      await Effect.runPromise(handlers.SniffingComplete({ _tag: 'SniffingComplete' }))
    })

    expect(harness.routerBack).toHaveBeenCalledTimes(1)
    expect(harness.routerPush).not.toHaveBeenCalled()
  })
})
