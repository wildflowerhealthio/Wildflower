/**
 * Tests for {@link CollectorModalScreen}.
 *
 * Behaviour pinned:
 *
 *  - Each sniffer event handler routes the decoded message through
 *    the Collector pipe sender so the embedded SPA's bridge
 *    dispatches it. `RequestError` additionally fires the optional
 *    `onError` callback (and the dispatch survives a callback throw).
 *  - The `BrowserSnifferWebView` ref (a `BrowserSnifferMessageSender`)
 *    is registered through the BrowserSniffer pipe so the receiver
 *    layer's `Click` / `CancelSnifferRequest` handlers can dispatch
 *    into the sniffer page.
 */
import { act, render } from '@testing-library/react-native'
import type * as EffectType from 'effect'
import { Effect } from 'effect'
import { type TransportAdapter } from 'effect-messaging-core'
import * as TestPlatformAdapterLayer from 'effect-messaging-core/test'
import * as React from 'react'
import type { ReactElement } from 'react'

import type { BrowserSnifferMessageSender, SnifferHandlers } from 'browser-sniffer-expo'
import type { BridgedWebViewLoadFrom } from 'effect-messaging-expo'

/**
 * Shared mutable harness — populated by the mocked
 * `BrowserSnifferWebView` so each test can inspect what props were
 * passed and fire the captured handlers directly.
 */
const mockHarness = {
  lastLoadFrom: null as BridgedWebViewLoadFrom | null,
  lastHandlers: null as SnifferHandlers | null,
  snifferCalls: [] as Array<{ readonly _tag: string; readonly [key: string]: unknown }>,
}

jest.mock('browser-sniffer-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  const { Effect: EffectInner } = jest.requireActual<typeof EffectType>('effect')
  return {
    BrowserSnifferWebView: ReactInner.forwardRef(function MockBrowserSnifferWebView(
      props: {
        readonly loadFrom: BridgedWebViewLoadFrom
        readonly browserSnifferHandlers: SnifferHandlers
      },
      ref: React.Ref<BrowserSnifferMessageSender>
    ): ReactElement {
      mockHarness.lastLoadFrom = props.loadFrom
      mockHarness.lastHandlers = props.browserSnifferHandlers
      const stableSender: BrowserSnifferMessageSender = (msg) =>
        EffectInner.sync(() => mockHarness.snifferCalls.push(msg))
      ReactInner.useImperativeHandle(ref, () => stableSender, [])
      return ReactInner.createElement('MockBrowserSnifferWebView', null)
    }),
  }
})

jest.mock('expo-tundraish', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    Spacing: { s5: 16 },
    ThemedView: (props: { readonly children?: React.ReactNode }): ReactElement =>
      ReactInner.createElement('ThemedView', props),
  }
})

// Pipe mock — the e2e test already exercises the real-pipe round-trip,
// so this mock only needs to: (a) act as a no-op Provider, (b) capture
// the sender installed via `useAsBrowserSnifferOutlet` into a single
// slot, and (c) return a recording sender from `useCollectorSender`.
let lastRegisteredSender: BrowserSnifferMessageSender | null = null
const mockCollectorCalls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
jest.mock('../message-sender-pipes.tsx', () => {
  const { Effect: EffectInner } = jest.requireActual<typeof EffectType>('effect')
  const ReactInner = jest.requireActual<typeof React>('react')
  const PassThroughProvider = ({
    children,
  }: {
    readonly children: React.ReactNode
  }): ReactElement => ReactInner.createElement(ReactInner.Fragment, null, children)
  return {
    BrowserSnifferPipeProvider: PassThroughProvider,
    CollectorPipeProvider: PassThroughProvider,
    useAsBrowserSnifferOutlet: (sender: BrowserSnifferMessageSender): void => {
      ReactInner.useEffect(() => {
        lastRegisteredSender = sender
      }, [sender])
    },
    useBrowserSnifferSender: (): BrowserSnifferMessageSender => () => EffectInner.void,
    useCollectorSender: (): ((msg: {
      readonly _tag: string
      readonly [key: string]: unknown
    }) => EffectType.Effect.Effect<void>) =>
      ReactInner.useCallback(
        (msg: { readonly _tag: string; readonly [key: string]: unknown }) =>
          EffectInner.sync(() => {
            mockCollectorCalls.push(msg)
          }),
        []
      ),
  }
})

import { CollectorModalScreen } from './CollectorModalScreen.tsx'

const requireHandlers = (): SnifferHandlers => {
  if (mockHarness.lastHandlers === null) {
    throw new Error('BrowserSnifferWebView mock never received handlers')
  }
  return mockHarness.lastHandlers
}

beforeEach(() => {
  mockHarness.lastLoadFrom = null
  mockHarness.lastHandlers = null
  mockHarness.snifferCalls = []
  mockCollectorCalls.length = 0
  lastRegisteredSender = null
})

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

const runHandlerPromise = <A, E>(eff: Effect.Effect<A, E, TransportAdapter>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, adapterLayer))

describe('CollectorModalScreen', () => {
  describe('source → loadFrom conversion', () => {
    it('Uri source maps to lowercase `_tag: uri`', () => {
      render(<CollectorModalScreen source={{ _tag: 'Uri', uri: 'https://example.test/a' }} />)
      expect(mockHarness.lastLoadFrom).toEqual({ _tag: 'uri', uri: 'https://example.test/a' })
    })

    it('Html with baseUrl maps to lowercase `_tag: html` with the baseUrl preserved', () => {
      render(
        <CollectorModalScreen
          source={{ _tag: 'Html', html: '<html></html>', baseUrl: 'https://app.example.test/' }}
        />
      )
      expect(mockHarness.lastLoadFrom).toEqual({
        _tag: 'html',
        html: '<html></html>',
        baseUrl: 'https://app.example.test/',
      })
    })

    it('Html without baseUrl falls back to about:blank', () => {
      render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
      expect(mockHarness.lastLoadFrom).toEqual({
        _tag: 'html',
        html: '<html></html>',
        baseUrl: 'about:blank',
      })
    })
  })

  describe('typed re-emit through the Collector pipe', () => {
    it('forwards ResponseStart verbatim', async () => {
      const event = {
        _tag: 'ResponseStart' as const,
        id: 'r1',
        url: 'u',
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/json']] as const,
      }
      render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
      await runHandlerPromise(requireHandlers().ResponseStart(event))
      expect(mockCollectorCalls).toEqual([event])
    })

    it('forwards ResponseData verbatim', async () => {
      const event = { _tag: 'ResponseData' as const, id: 'r1', data: 'b64' }
      render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
      await runHandlerPromise(requireHandlers().ResponseData(event))
      expect(mockCollectorCalls).toEqual([event])
    })

    it('forwards ResponseFinished verbatim', async () => {
      const event = { _tag: 'ResponseFinished' as const, id: 'r1' }
      render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
      await runHandlerPromise(requireHandlers().ResponseFinished(event))
      expect(mockCollectorCalls).toEqual([event])
    })

    it('forwards Cancelled verbatim', async () => {
      const event = { _tag: 'Cancelled' as const, id: 'r1' }
      render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
      await runHandlerPromise(requireHandlers().Cancelled(event))
      expect(mockCollectorCalls).toEqual([event])
    })

    it('forwards PageLoaded verbatim', async () => {
      const event = { _tag: 'PageLoaded' as const, url: 'u', pageContentId: 'p' }
      render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
      await runHandlerPromise(requireHandlers().PageLoaded(event))
      expect(mockCollectorCalls).toEqual([event])
    })
  })

  describe('RequestError handler', () => {
    it('fires the optional onError callback AND forwards through the collector pipe', async () => {
      const onError = jest.fn()
      render(
        <CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} onError={onError} />
      )
      const event = {
        _tag: 'RequestError' as const,
        id: 'r1',
        url: 'https://example.test',
        message: 'oh no',
      }
      await runHandlerPromise(requireHandlers().RequestError(event))
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith(event)
      expect(mockCollectorCalls).toEqual([event])
    })

    it('swallows onError throws so the dispatch fiber keeps draining and still re-emits', async () => {
      const onError = jest.fn((): void => {
        throw new Error('boom')
      })
      render(
        <CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} onError={onError} />
      )
      const event = {
        _tag: 'RequestError' as const,
        id: 'r1',
        url: 'https://example.test',
        message: 'boom',
      }
      await expect(
        runHandlerPromise(requireHandlers().RequestError(event))
      ).resolves.toBeUndefined()
      expect(onError).toHaveBeenCalledTimes(1)
      expect(mockCollectorCalls).toEqual([event])
    })
  })

  describe('sniffer-pipe registration', () => {
    it('registers the WebView ref sender through useAsBrowserSnifferOutlet', async () => {
      render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
      if (lastRegisteredSender === null) {
        throw new Error('No sender was registered through useAsBrowserSnifferOutlet')
      }
      await act(async () => {
        await Effect.runPromise(lastRegisteredSender!({ _tag: 'Click', querySelector: '#go' }))
      })
      expect(mockHarness.snifferCalls).toEqual([{ _tag: 'Click', querySelector: '#go' }])
    })
  })
})
