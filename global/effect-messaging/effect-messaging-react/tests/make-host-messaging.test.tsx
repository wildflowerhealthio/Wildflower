/* oxlint-disable typescript/no-unsafe-type-assertion -- the recording-sender
   helper widens a single-signature thunk to the function-intersection
   `Bridge.MessageSender`. Runtime dispatches by `_tag`; the cast is the
   centralised test fixture for that. */
import { renderHook } from '@testing-library/react'
import { Effect, Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'
import { describe, expect, test, vi } from 'vite-plus/test'

import { makeHostMessaging, NoContextException } from '../src/make-host-messaging.tsx'

const HostBackRequested = Schema.parseJson(Schema.TaggedStruct('HostBackRequested', {}))
const HostRequestedWebNavigation = Schema.parseJson(
  Schema.TaggedStruct('HostRequestedWebNavigation', { path: Schema.String })
)
const RouteChanged = Schema.parseJson(
  Schema.TaggedStruct('RouteChanged', { pathname: Schema.String, canGoBack: Schema.Boolean })
)
const NavigationBridge = Bridge.make({
  name: 'Navigation',
  hostToWeb: [
    ['HostBackRequested', HostBackRequested],
    ['HostRequestedWebNavigation', HostRequestedWebNavigation],
  ] as const,
  webToHost: [['RouteChanged', RouteChanged]] as const,
})

const AuthTokenIssued = Schema.parseJson(
  Schema.TaggedStruct('AuthTokenIssued', { token: Schema.String })
)
const GatekeeperBridge = Bridge.make({
  name: 'Gatekeeper',
  hostToWeb: [['AuthTokenIssued', AuthTokenIssued]] as const,
  webToHost: [] as const,
})

type TestBridges = readonly [typeof NavigationBridge, typeof GatekeeperBridge]
const bridges: TestBridges = [NavigationBridge, GatekeeperBridge] as const

const makeRecordingSender = <B extends ReadonlyArray<Bridge.AnyBridge>>(): {
  readonly sender: Bridge.MessageSender<B, 'Host'>
  readonly received: ReadonlyArray<{ readonly _tag: string }>
} => {
  const received: Array<{ readonly _tag: string }> = []
  const sender = ((message: { readonly _tag: string }): Effect.Effect<void> =>
    Effect.sync(() => {
      received.push(message)
    })) as unknown as Bridge.MessageSender<B, 'Host'>
  return { sender, received }
}

const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

describe('makeHostMessaging — HostMessagingProvider', () => {
  test('useHostMessageSender forwards a typed message to the underlying sendMessage', async () => {
    const { HostMessagingProvider, useHostMessageSender } = makeHostMessaging(bridges)
    const { sender, received } = makeRecordingSender<TestBridges>()

    const { result } = renderHook(() => useHostMessageSender(NavigationBridge), {
      wrapper: ({ children }) => (
        <HostMessagingProvider sendMessage={sender}>{children}</HostMessagingProvider>
      ),
    })

    await Effect.runPromise(
      result.current.sendEffect({ _tag: 'HostRequestedWebNavigation', path: '/apps' })
    )
    expect(received).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/apps' }])
  })

  test('useHostMessageSender returns a stable object across re-renders', () => {
    const { HostMessagingProvider, useHostMessageSender } = makeHostMessaging(bridges)
    const { sender } = makeRecordingSender<TestBridges>()

    const { result, rerender } = renderHook(() => useHostMessageSender(NavigationBridge), {
      wrapper: ({ children }) => (
        <HostMessagingProvider sendMessage={sender}>{children}</HostMessagingProvider>
      ),
    })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  test('useHostMessageSender throws NoContextException outside a provider', () => {
    const { useHostMessageSender } = makeHostMessaging(bridges)
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useHostMessageSender(NavigationBridge))).toThrow(
        NoContextException
      )
    } finally {
      restore()
    }
  })

  test('send is fire-and-forget — same Effect as sendEffect', async () => {
    const { HostMessagingProvider, useHostMessageSender } = makeHostMessaging(bridges)
    const { sender, received } = makeRecordingSender<TestBridges>()

    const { result } = renderHook(() => useHostMessageSender(GatekeeperBridge), {
      wrapper: ({ children }) => (
        <HostMessagingProvider sendMessage={sender}>{children}</HostMessagingProvider>
      ),
    })
    const ret = result.current.send({ _tag: 'AuthTokenIssued', token: 'tk' })
    // Microtask flush so the forked Effect lands.
    await Promise.resolve()
    expect(ret).toBeUndefined()
    expect(received).toEqual([{ _tag: 'AuthTokenIssued', token: 'tk' }])
  })
})

describe('makeHostMessaging — HoistedHostMessagingProvider', () => {
  test('sends before any sender is registered log-warn and drop', async () => {
    const { HoistedHostMessagingProvider, useHostMessageSender } = makeHostMessaging(bridges)

    const { result } = renderHook(() => useHostMessageSender(NavigationBridge), {
      wrapper: ({ children }) => (
        <HoistedHostMessagingProvider>{children}</HoistedHostMessagingProvider>
      ),
    })

    // No useRegisterHostSender has run — sender is still null. The Effect
    // resolves to a logWarning that completes successfully.
    const exit = await Effect.runPromise(
      Effect.exit(result.current.sendEffect({ _tag: 'HostBackRequested' }))
    )
    expect(exit._tag).toBe('Success')
  })

  test('register → send forwards to the registered sender', async () => {
    const { HoistedHostMessagingProvider, useRegisterHostSender, useHostMessageSender } =
      makeHostMessaging(bridges)
    const { sender, received } = makeRecordingSender<TestBridges>()

    const { result } = renderHook(
      () => {
        useRegisterHostSender(sender)
        return useHostMessageSender(NavigationBridge)
      },
      {
        wrapper: ({ children }) => (
          <HoistedHostMessagingProvider>{children}</HoistedHostMessagingProvider>
        ),
      }
    )

    await Effect.runPromise(
      result.current.sendEffect({ _tag: 'HostRequestedWebNavigation', path: '/x' })
    )
    expect(received).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/x' }])
  })

  test('re-register replaces the active sender', async () => {
    const { HoistedHostMessagingProvider, useRegisterHostSender, useHostMessageSender } =
      makeHostMessaging(bridges)
    const first = makeRecordingSender<TestBridges>()
    const second = makeRecordingSender<TestBridges>()

    const { result, rerender } = renderHook(
      ({ which }: { which: 'first' | 'second' }) => {
        useRegisterHostSender(which === 'first' ? first.sender : second.sender)
        return useHostMessageSender(NavigationBridge)
      },
      {
        wrapper: ({ children }) => (
          <HoistedHostMessagingProvider>{children}</HoistedHostMessagingProvider>
        ),
        initialProps: { which: 'first' },
      }
    )
    await Effect.runPromise(result.current.sendEffect({ _tag: 'HostBackRequested' }))
    rerender({ which: 'second' })
    await Effect.runPromise(result.current.sendEffect({ _tag: 'HostBackRequested' }))

    expect(first.received).toEqual([{ _tag: 'HostBackRequested' }])
    expect(second.received).toEqual([{ _tag: 'HostBackRequested' }])
  })

  test('useRegisterHostSender throws NoContextException outside a HoistedHostMessagingProvider', () => {
    const { useRegisterHostSender } = makeHostMessaging(bridges)
    const { sender } = makeRecordingSender<TestBridges>()
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useRegisterHostSender(sender))).toThrow(NoContextException)
    } finally {
      restore()
    }
  })
})
