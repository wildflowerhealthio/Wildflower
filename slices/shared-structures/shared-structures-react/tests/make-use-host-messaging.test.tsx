import { renderHook } from '@testing-library/react'
import { Effect, Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'
import { HostMessagingProvider } from 'effect-messaging-react'
import { describe, expect, test, vi } from 'vite-plus/test'
import { makeUseHostMessaging } from '../src/make-use-host-messaging.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', {}))
const Echo = Schema.parseJson(Schema.TaggedStruct('Echo', { text: Schema.String }))
const TestBridge = Bridge.make({
  name: 'Test',
  hostToWeb: [
    ['Ping', Ping],
    ['Echo', Echo],
  ] as const,
  webToHost: [] as const,
})

const Other = Schema.parseJson(Schema.TaggedStruct('Other', {}))
const SiblingBridge = Bridge.make({
  name: 'Sibling',
  hostToWeb: [['Other', Other]] as const,
  webToHost: [] as const,
})

const recordingSendMessage = <Bridges extends ReadonlyArray<Bridge.AnyBridge>>(
  sink: Array<{ readonly _tag: string }>
): Bridge.MessageSender<Bridges, 'Host'> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ((message: { readonly _tag: string }): Effect.Effect<void> =>
    Effect.sync(() => {
      sink.push(message)
    })) as unknown as Bridge.MessageSender<Bridges, 'Host'>

describe('makeUseHostMessaging', () => {
  test('throws when the requested bridge is not registered in the provider', () => {
    const useTestHostMessaging = makeUseHostMessaging(TestBridge)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() =>
      renderHook(useTestHostMessaging, {
        wrapper: ({ children }) => (
          <HostMessagingProvider
            bridges={[SiblingBridge] as const}
            sendMessage={recordingSendMessage<readonly [typeof SiblingBridge]>([])}
          >
            {children}
          </HostMessagingProvider>
        ),
      })
    ).toThrow(/TestBridge is not registered/)
    consoleError.mockRestore()
  })

  test('forwards typed messages through the underlying sendMessage when the bridge is registered', async () => {
    const useTestHostMessaging = makeUseHostMessaging(TestBridge)
    const sent: Array<{ readonly _tag: string }> = []
    const { result } = renderHook(useTestHostMessaging, {
      wrapper: ({ children }) => (
        <HostMessagingProvider
          bridges={[TestBridge] as const}
          sendMessage={recordingSendMessage<readonly [typeof TestBridge]>(sent)}
        >
          {children}
        </HostMessagingProvider>
      ),
    })
    await Effect.runPromise(result.current.sendEffect({ _tag: 'Echo', text: 'hi' }))
    expect(sent).toEqual([{ _tag: 'Echo', text: 'hi' }])
  })

  test('returns a stable messaging object across re-renders when provider inputs are stable', () => {
    const useTestHostMessaging = makeUseHostMessaging(TestBridge)
    const stableBridges = [TestBridge] as const
    const stableSend = recordingSendMessage<typeof stableBridges>([])
    const { result, rerender } = renderHook(useTestHostMessaging, {
      wrapper: ({ children }) => (
        <HostMessagingProvider bridges={stableBridges} sendMessage={stableSend}>
          {children}
        </HostMessagingProvider>
      ),
    })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
