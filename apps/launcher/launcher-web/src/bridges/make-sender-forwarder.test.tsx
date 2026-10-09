import { render } from '@testing-library/react'
import { Effect } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { describe, expect, test } from 'vite-plus/test'

import { makeSliceSenderForwarder, type SliceSenderProvider } from './make-sender-forwarder.tsx'
import { type ReactTransport, TransportContext } from './transport-context.ts'

const fakeTransport: ReactTransport = {
  sendMessage: () => Effect.void,
  coordinator: { register: () => Effect.void, unregister: () => Effect.void },
}

const makeRecordingProvider = (
  seenSenders: Array<ReactTransport['sendMessage']>
): SliceSenderProvider => {
  const RecordingProvider = ({
    send,
    children,
  }: {
    readonly send: ReactTransport['sendMessage']
    readonly children: ReactNode
  }): JSX.Element => {
    seenSenders.push(send)
    return <div data-testid="slice-provider">{children}</div>
  }
  return RecordingProvider
}

const PassThroughProvider: SliceSenderProvider = ({ children }) => <>{children}</>

describe('makeSliceSenderForwarder', () => {
  test('feeds the transport.sendMessage into the slice provider', () => {
    const seenSenders: Array<ReactTransport['sendMessage']> = []
    const Forwarder = makeSliceSenderForwarder('TestForwarder', makeRecordingProvider(seenSenders))

    const { getByTestId } = render(
      <TransportContext.Provider value={fakeTransport}>
        <Forwarder>
          <span>child</span>
        </Forwarder>
      </TransportContext.Provider>
    )

    expect(getByTestId('slice-provider')).toBeDefined()
    expect(seenSenders).toHaveLength(1)
    expect(seenSenders[0]).toBe(fakeTransport.sendMessage)
  })

  test('sets the supplied displayName on the returned component', () => {
    const Forwarder = makeSliceSenderForwarder('PreciseName', PassThroughProvider)
    // The forwarder is returned as a plain function. React reads
    // `displayName` off the function object for DevTools and the
    // root-shell render-order assertion; assert it's set.
    expect(Forwarder.displayName).toBe('PreciseName')
  })

  test('passes the same sender identity to the provider across rerenders of the same transport', () => {
    const seenSenders: Array<ReactTransport['sendMessage']> = []
    const Forwarder = makeSliceSenderForwarder('Stability', makeRecordingProvider(seenSenders))

    const { rerender } = render(
      <TransportContext.Provider value={fakeTransport}>
        <Forwarder>
          <span>a</span>
        </Forwarder>
      </TransportContext.Provider>
    )
    rerender(
      <TransportContext.Provider value={fakeTransport}>
        <Forwarder>
          <span>b</span>
        </Forwarder>
      </TransportContext.Provider>
    )

    expect(seenSenders).toHaveLength(2)
    expect(seenSenders[0]).toBe(seenSenders[1])
  })
})
