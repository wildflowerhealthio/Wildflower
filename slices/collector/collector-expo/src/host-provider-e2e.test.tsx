/**
 * End-to-end smoke test for the collector-expo wiring. Uses the
 * **real** `useCollectorHostHandlers` record (no `jest.mock` for the
 * bridge), the real `makeNamedPipe`-built pipes, and the real
 * `CollectorHostProvider` — only `expo-router` is stubbed because
 * there's no router stack in the test environment.
 */
import * as React from 'react'

import { act, render } from '@testing-library/react-native'
import type { BrowserSnifferBridge } from 'browser-sniffer-core/bridge'
import type * as BrowserSnifferExpoModule from 'browser-sniffer-expo'
import type { CollectorBridge } from 'collector-fundamentals/bridge'
import { Effect } from 'effect'
import { type BridgeTransport, TransportAdapter } from 'effect-messaging-core'
import type * as ExpoRouterModule from 'expo-router'
import type * as ExpoTundraishModule from 'expo-tundraish'
import { useEffect, type ReactElement } from 'react'

// The e2e test only stubs the native deps; the bridge + pipes run real.
jest.mock(
  'expo-router',
  (): Partial<typeof ExpoRouterModule> => ({
    useRouter: (): ReturnType<typeof ExpoRouterModule.useRouter> =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      ({
        push: jest.fn(),
        back: jest.fn(),
      }) as unknown as ReturnType<typeof ExpoRouterModule.useRouter>,
  })
)

jest.mock('browser-sniffer-expo', (): Partial<typeof BrowserSnifferExpoModule> => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
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

import {
  CollectorHostProvider,
  useAsBrowserSnifferOutlet,
  useAsCollectorOutlet,
  useCollectorHostHandlers,
  useCollectorSender,
} from './index.ts'

type SnifferSender = BridgeTransport.MessageSender<
  readonly [typeof BrowserSnifferBridge],
  'HostToWeb'
>
type CollectorSender = BridgeTransport.MessageSender<readonly [typeof CollectorBridge], 'HostToWeb'>
type CollectorHandlers = ReturnType<typeof useCollectorHostHandlers>

const ProbeInsideProvider = ({
  snifferSender,
  collectorSender,
  onCollectorPipeRead,
  onHandlersReady,
}: {
  readonly snifferSender: SnifferSender
  readonly collectorSender: CollectorSender
  readonly onCollectorPipeRead: (send: CollectorSender) => void
  readonly onHandlersReady: (handlers: CollectorHandlers) => void
}): ReactElement | null => {
  const handlers = useCollectorHostHandlers()
  useAsBrowserSnifferOutlet(snifferSender)
  useAsCollectorOutlet(collectorSender)
  const collectorRead = useCollectorSender()

  useEffect(() => {
    onHandlersReady(handlers)
    onCollectorPipeRead(collectorRead)
  }, [handlers, collectorRead, onHandlersReady, onCollectorPipeRead])

  return null
}

describe('collector-expo end-to-end pipe wiring', () => {
  it('Click handled by the real useCollectorHostHandlers record reaches the registered BrowserSniffer sender', async () => {
    const snifferCalls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const snifferSender: SnifferSender = (msg) => Effect.sync(() => snifferCalls.push(msg))
    const collectorSender: CollectorSender = () => Effect.void

    let capturedCollectorRead: CollectorSender | null = null
    let capturedHandlers: CollectorHandlers | null = null
    render(
      <CollectorHostProvider>
        <ProbeInsideProvider
          snifferSender={snifferSender}
          collectorSender={collectorSender}
          onCollectorPipeRead={(s) => {
            capturedCollectorRead = s
          }}
          onHandlersReady={(h) => {
            capturedHandlers = h
          }}
        />
      </CollectorHostProvider>
    )
    if (capturedHandlers === null) {
      throw new Error('Handler record was not captured')
    }
    if (capturedCollectorRead === null) {
      throw new Error('Collector pipe-read sender was not captured')
    }
    const handlers: CollectorHandlers = capturedHandlers

    // The handler forwards `Click` straight through the BrowserSniffer
    // pipe to the registered sender. As a `HandlersFor` member it carries a
    // `TransportAdapter` requirement (handlers may reply via same-bridge
    // `send`); this one never touches it, so a stub adapter discharges the
    // requirement without affecting what the test exercises.
    await act(async () => {
      await Effect.runPromise(
        handlers.Click({ _tag: 'Click', querySelector: '#submit' }).pipe(
          Effect.provideService(TransportAdapter, {
            bareSender: () => Effect.void,
            drainInitial: Effect.succeed([]),
          })
        )
      )
    })

    expect(snifferCalls).toEqual([{ _tag: 'Click', querySelector: '#submit' }])
  })

  it('A send through useCollectorSender reaches the registered Collector sender', async () => {
    const snifferSender: SnifferSender = () => Effect.void
    const collectorCalls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const collectorSender: CollectorSender = (msg) => Effect.sync(() => collectorCalls.push(msg))

    let capturedCollectorRead: CollectorSender | null = null
    render(
      <CollectorHostProvider>
        <ProbeInsideProvider
          snifferSender={snifferSender}
          collectorSender={collectorSender}
          onCollectorPipeRead={(s) => {
            capturedCollectorRead = s
          }}
          onHandlersReady={() => undefined}
        />
      </CollectorHostProvider>
    )
    if (capturedCollectorRead === null) {
      throw new Error('Collector pipe-read sender was not captured')
    }
    const collectorRead: CollectorSender = capturedCollectorRead

    const event = {
      _tag: 'PageLoaded' as const,
      url: 'https://example.com/done',
      pageContentId: 'p-1',
    }
    await act(async () => {
      await Effect.runPromise(collectorRead(event))
    })

    expect(collectorCalls).toEqual([event])
  })
})
