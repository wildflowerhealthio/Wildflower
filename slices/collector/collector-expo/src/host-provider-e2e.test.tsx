/**
 * End-to-end smoke test for the collector-expo wiring. Uses the
 * **real** `CollectorBridge.Host.ReceiverLayer` (no `jest.mock` for
 * the bridge), the real `makeNamedPipe`-built pipes, and the real
 * `HostProvider` — only `expo-router` is stubbed because there's no
 * router stack in the test environment.
 */
import { act, render } from '@testing-library/react-native'
import type BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import CollectorBridge from 'collector-fundamentals/bridge'
import { Effect, Layer } from 'effect'
import { BareSender, type BridgeTransport } from 'effect-messaging-core'
import { useEffect, type ReactElement } from 'react'

import {
  mockBuildBrowserSnifferExpoFactory,
  mockBuildExpoRouterFactory,
  mockBuildExpoTundraishFactory,
  resetHarness,
} from './__test-support__/host-provider-test-mocks.ts'

jest.mock('expo-router', () => mockBuildExpoRouterFactory())
jest.mock('browser-sniffer-expo', () => mockBuildBrowserSnifferExpoFactory())
jest.mock('expo-tundraish', () => mockBuildExpoTundraishFactory())

import {
  CollectorBridgeExpo,
  useAsBrowserSnifferSource,
  useAsCollectorSource,
  useCollectorSender,
} from './index.ts'

type SnifferSender = BridgeTransport.MessageSender<readonly [typeof BrowserSnifferBridge], 'Host'>
type CollectorSender = BridgeTransport.MessageSender<readonly [typeof CollectorBridge], 'Host'>

const noopBareSender = Layer.succeed(BareSender, { bareSender: () => Effect.void })

const ProbeInsideProvider = ({
  snifferSender,
  collectorSender,
  onCollectorPipeRead,
  onLayerReady,
}: {
  readonly snifferSender: SnifferSender
  readonly collectorSender: CollectorSender
  readonly onCollectorPipeRead: (send: CollectorSender) => void
  readonly onLayerReady: (layer: ReturnType<typeof CollectorBridgeExpo.useReceiverLayer>) => void
}): ReactElement | null => {
  const layer = CollectorBridgeExpo.useReceiverLayer()
  useAsBrowserSnifferSource(snifferSender)
  useAsCollectorSource(collectorSender)
  const collectorRead = useCollectorSender()

  useEffect(() => {
    onLayerReady(layer)
    onCollectorPipeRead(collectorRead)
  }, [layer, collectorRead, onLayerReady, onCollectorPipeRead])

  return null
}

beforeEach(() => {
  resetHarness()
})

describe('CollectorBridgeExpo end-to-end pipe wiring', () => {
  it('Click decoded by the real CollectorBridge receiver layer reaches the registered BrowserSniffer sender', async () => {
    const snifferCalls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const snifferSender: SnifferSender = (msg) => Effect.sync(() => snifferCalls.push(msg))
    const collectorSender: CollectorSender = () => Effect.void

    let capturedCollectorRead: CollectorSender | null = null
    let capturedLayer: ReturnType<typeof CollectorBridgeExpo.useReceiverLayer> | null = null
    render(
      <CollectorBridgeExpo.HostProvider>
        <ProbeInsideProvider
          snifferSender={snifferSender}
          collectorSender={collectorSender}
          onCollectorPipeRead={(s) => {
            capturedCollectorRead = s
          }}
          onLayerReady={(l) => {
            capturedLayer = l
          }}
        />
      </CollectorBridgeExpo.HostProvider>
    )
    if (capturedLayer === null) {
      throw new Error('Receiver layer was not captured')
    }
    if (capturedCollectorRead === null) {
      throw new Error('Collector pipe-read sender was not captured')
    }
    const layer: ReturnType<typeof CollectorBridgeExpo.useReceiverLayer> = capturedLayer

    const dispatchClick = Effect.gen(function* () {
      const service = yield* CollectorBridge.Host.HandlerTag
      yield* service.Click({ _tag: 'Click', querySelector: '#submit' })
    }).pipe(Effect.provide(layer), Effect.provide(noopBareSender))

    await act(async () => {
      await Effect.runPromise(dispatchClick)
    })

    expect(snifferCalls).toEqual([{ _tag: 'Click', querySelector: '#submit' }])
  })

  it('A send through useCollectorSender reaches the registered Collector sender', async () => {
    const snifferSender: SnifferSender = () => Effect.void
    const collectorCalls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const collectorSender: CollectorSender = (msg) => Effect.sync(() => collectorCalls.push(msg))

    let capturedCollectorRead: CollectorSender | null = null
    render(
      <CollectorBridgeExpo.HostProvider>
        <ProbeInsideProvider
          snifferSender={snifferSender}
          collectorSender={collectorSender}
          onCollectorPipeRead={(s) => {
            capturedCollectorRead = s
          }}
          onLayerReady={() => undefined}
        />
      </CollectorBridgeExpo.HostProvider>
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
