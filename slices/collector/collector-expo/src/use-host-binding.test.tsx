/**
 * Regression test for the `CollectorPipe` outlet wiring. Before this
 * binding installed `onTransportReady`, no production code called
 * `useAsCollectorOutlet`, so `useCollectorSender()` always fell through
 * to the pipe's warn-and-drop default sender — observable in the logs
 * as `"[effect-messaging] no CollectorPipe handler registered; dropping
 * message ..."` for every sniffer event the modal forwarded. This test
 * pins that the binding's `onTransportReady` populates the pipe's
 * sender ref so subsequent `useCollectorSender()` calls reach the
 * host-built transport's outbound sender.
 */
import { act, render } from '@testing-library/react-native'
import type { CollectorBridge } from 'collector-fundamentals/bridge'
import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import type * as ExpoRouterModule from 'expo-router'
import { useEffect, type ReactElement } from 'react'

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

// Direct imports (not via `./index.ts`) so the test doesn't transitively
// load `CollectorModalScreen` and pull `react-native-webview`'s
// TurboModule registration into the Jest environment.
import { CollectorHostProvider } from './collector-host-context.tsx'
import { useCollectorSender } from './message-sender-pipes.tsx'
import { useCollectorHostBinding } from './use-host-binding.ts'

type CollectorSender = BridgeTransport.MessageSender<readonly [typeof CollectorBridge], 'Host'>
type CollectorBinding = ReturnType<typeof useCollectorHostBinding>

const ProbeInsideProvider = ({
  onBindingReady,
  onSenderReady,
}: {
  readonly onBindingReady: (binding: CollectorBinding) => void
  readonly onSenderReady: (sender: CollectorSender) => void
}): ReactElement | null => {
  const binding = useCollectorHostBinding()
  const sender = useCollectorSender()

  useEffect(() => {
    onBindingReady(binding)
    onSenderReady(sender)
  }, [binding, sender, onBindingReady, onSenderReady])

  return null
}

describe('useCollectorHostBinding onTransportReady', () => {
  it('installs the host-built transport sender into the CollectorPipe so useCollectorSender reaches it', async () => {
    const collectorCalls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const hostTransportSender: CollectorSender = (msg) =>
      Effect.sync(() => collectorCalls.push(msg))

    let capturedBinding: CollectorBinding | null = null
    let capturedSender: CollectorSender | null = null
    render(
      <CollectorHostProvider>
        <ProbeInsideProvider
          onBindingReady={(b) => {
            capturedBinding = b
          }}
          onSenderReady={(s) => {
            capturedSender = s
          }}
        />
      </CollectorHostProvider>
    )

    if (capturedBinding === null) {
      throw new Error('useCollectorHostBinding did not produce a binding')
    }
    if (capturedSender === null) {
      throw new Error('useCollectorSender did not produce a sender')
    }
    const binding: CollectorBinding = capturedBinding
    const sender: CollectorSender = capturedSender

    const onReady = binding.onTransportReady[0]
    if (onReady === undefined) {
      throw new Error('binding.onTransportReady[0] is undefined; expected the install callback')
    }

    // Wire the recording sender as the "host transport sender" — what
    // `BridgedWebView` would fire after building the transport.
    await act(async () => {
      await Effect.runPromise(onReady(hostTransportSender))
    })

    const event = {
      _tag: 'PageLoaded' as const,
      url: 'https://example.com/done',
      pageContentId: 'p-1',
    }
    await act(async () => {
      await Effect.runPromise(sender(event))
    })

    expect(collectorCalls).toEqual([event])
  })
})
