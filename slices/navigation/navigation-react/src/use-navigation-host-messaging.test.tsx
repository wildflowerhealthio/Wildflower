import { renderHook } from '@testing-library/react'
import { Effect, Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'
import { HostMessagingProvider } from 'effect-messaging-react'
import { NavigationBridge } from 'navigation-core'
import { describe, expect, test, vi } from 'vite-plus/test'
import { useNavigationHostMessaging } from './use-navigation-host-messaging.ts'

// Sibling fixture bridge used to mount a provider that *doesn't* register Navigation.
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', {}))
const SiblingBridge = Bridge.make({
  name: 'Sibling',
  hostToWeb: [['Pong', Pong]] as const,
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

describe('useNavigationHostMessaging', () => {
  test('throws when NavigationBridge is not registered in the provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() =>
      renderHook(useNavigationHostMessaging, {
        wrapper: ({ children }) => (
          <HostMessagingProvider
            bridges={[SiblingBridge] as const}
            sendMessage={recordingSendMessage<readonly [typeof SiblingBridge]>([])}
          >
            {children}
          </HostMessagingProvider>
        ),
      })
    ).toThrow(/NavigationBridge is not registered/)
    consoleError.mockRestore()
  })

  test('forwards typed navigation messages to the underlying sendMessage', async () => {
    const sent: Array<{ readonly _tag: string }> = []
    const { result } = renderHook(useNavigationHostMessaging, {
      wrapper: ({ children }) => (
        <HostMessagingProvider
          bridges={[NavigationBridge] as const}
          sendMessage={recordingSendMessage<readonly [typeof NavigationBridge]>(sent)}
        >
          {children}
        </HostMessagingProvider>
      ),
    })

    await Effect.runPromise(
      result.current.sendEffect({ _tag: 'HostRequestedWebNavigation', path: '/apps' })
    )
    expect(sent).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/apps' }])
  })
})
