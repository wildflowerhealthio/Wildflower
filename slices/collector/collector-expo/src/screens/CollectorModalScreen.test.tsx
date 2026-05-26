/**
 * Tests for {@link CollectorModalScreen}.
 *
 * Behaviour pinned:
 *
 *  - Each sniffer event handler routes the decoded message through
 *    `useMessageSenderToCollector` so the embedded SPA's bridge
 *    dispatches it. `RequestError` additionally fires the optional
 *    `onError` callback (and the dispatch survives a callback throw).
 *  - The `BrowserSnifferWebView` ref (a `BrowserSnifferMessageSender`)
 *    is registered through `useAsMessageSenderToBrowserSniffer` so
 *    the receiver layer's `Click` / `CancelSnifferRequest` handlers
 *    can dispatch into the sniffer page.
 *  - `WebViewSource.Any → BridgedWebViewLoadFrom` conversion is
 *    correct for both `Uri` and `Html` variants.
 */
import { act, render } from '@testing-library/react-native'
import type * as EffectType from 'effect'
import { Effect } from 'effect'
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
  // The mock's stable sender — returned via ref. Records each call so
  // tests can assert the sniffer pipe round-trip.
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
      // Mirrors the real component's stable `BrowserSnifferMessageSender` ref shape.
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

// `useMessageSenderToCollector` reads from a real
// `makeMessageSenderPipe`-built context inside `HostProvider`. The
// screen test wraps in a thin custom provider that records dispatch
// calls (avoids dragging in `expo-router` etc.).
const mockCollectorCalls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
jest.mock('../message-sender-pipes.tsx', () => {
  const { Effect: EffectInner } = jest.requireActual<typeof EffectType>('effect')
  const ReactInner = jest.requireActual<typeof React>('react')
  let registeredSnifferSender: BrowserSnifferMessageSender | null = null
  const PassThroughProvider = ({
    children,
  }: {
    readonly children: React.ReactNode
  }): ReactElement => ReactInner.createElement(ReactInner.Fragment, null, children)
  return {
    MessageSenderToBrowserSnifferProvider: PassThroughProvider,
    MessageSenderToCollectorProvider: PassThroughProvider,
    useAsMessageSenderToBrowserSniffer: (sender: BrowserSnifferMessageSender): void => {
      ReactInner.useEffect(() => {
        registeredSnifferSender = sender
      }, [sender])
    },
    useAsMessageSenderToCollector: (): void => undefined,
    useMessageSenderToBrowserSniffer: (): BrowserSnifferMessageSender =>
      ReactInner.useCallback(
        (msg) =>
          EffectInner.suspend(() =>
            registeredSnifferSender === null ? EffectInner.void : registeredSnifferSender(msg)
          ),
        []
      ),
    useMessageSenderToCollector: () =>
      ReactInner.useCallback(
        (msg: { readonly _tag: string; readonly [key: string]: unknown }) =>
          EffectInner.sync(() => {
            mockCollectorCalls.push(msg)
          }),
        []
      ),
    // Expose the internal slot for tests that assert
    // the sniffer-pipe round-trip.
    getRegisteredSnifferSender: (): BrowserSnifferMessageSender | null => registeredSnifferSender,
  }
})

import { CollectorModalScreen } from './CollectorModalScreen.tsx'

beforeEach(() => {
  mockHarness.lastLoadFrom = null
  mockHarness.lastHandlers = null
  mockHarness.snifferCalls = []
  mockCollectorCalls.length = 0
})

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

  describe('typed re-emit through useMessageSenderToCollector', () => {
    type Case = readonly [string, { readonly _tag: string } & Readonly<Record<string, unknown>>]
    const cases: ReadonlyArray<Case> = [
      ['ResponseStart', { _tag: 'ResponseStart', id: 'r1', url: 'u', status: 200 }],
      ['ResponseData', { _tag: 'ResponseData', id: 'r1', data: 'b64' }],
      ['ResponseFinished', { _tag: 'ResponseFinished', id: 'r1' }],
      ['Cancelled', { _tag: 'Cancelled', id: 'r1' }],
      ['PageLoaded', { _tag: 'PageLoaded', url: 'u', pageContentId: 'p' }],
    ]
    it.each(cases)('forwards %s verbatim through the collector pipe', async (tag, event) => {
      render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
      const handlers = mockHarness.lastHandlers
      expect(handlers).not.toBeNull()
      if (handlers === null) return
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const handlersRecord = handlers as unknown as Readonly<
        Record<string, ((e: unknown) => Effect.Effect<void>) | undefined>
      >
      const handler = handlersRecord[tag]
      expect(handler).toBeDefined()
      if (handler === undefined) return
      await Effect.runPromise(handler(event))
      expect(mockCollectorCalls).toEqual([event])
    })
  })

  describe('RequestError handler', () => {
    it('fires the optional onError callback AND forwards through the collector pipe', async () => {
      const onError = jest.fn()
      render(
        <CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} onError={onError} />
      )
      const handlers = mockHarness.lastHandlers
      expect(handlers).not.toBeNull()
      if (handlers === null) return
      const event = {
        _tag: 'RequestError' as const,
        id: 'r1',
        url: 'https://example.test',
        message: 'oh no',
      }
      await Effect.runPromise(handlers.RequestError(event))
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
      const handlers = mockHarness.lastHandlers
      expect(handlers).not.toBeNull()
      if (handlers === null) return
      const event = {
        _tag: 'RequestError' as const,
        id: 'r1',
        url: 'https://example.test',
        message: 'boom',
      }
      await expect(Effect.runPromise(handlers.RequestError(event))).resolves.toBeUndefined()
      expect(onError).toHaveBeenCalledTimes(1)
      expect(mockCollectorCalls).toEqual([event])
    })
  })

  describe('sniffer-pipe registration', () => {
    it('registers the WebView ref sender through useAsMessageSenderToBrowserSniffer', async () => {
      render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
      // After mount, the screen's useEffect has installed the sender
      // exposed by the mocked BrowserSnifferWebView. The pipe mock
      // exposes the registered value via a private accessor.
      const pipeMock = jest.requireMock<{
        getRegisteredSnifferSender: () => BrowserSnifferMessageSender | null
      }>('../message-sender-pipes.tsx')
      const registered = pipeMock.getRegisteredSnifferSender()
      expect(registered).not.toBeNull()
      if (registered === null) return
      await act(async () => {
        await Effect.runPromise(registered({ _tag: 'Click', querySelector: '#go' }))
      })
      expect(mockHarness.snifferCalls).toEqual([{ _tag: 'Click', querySelector: '#go' }])
    })
  })
})
