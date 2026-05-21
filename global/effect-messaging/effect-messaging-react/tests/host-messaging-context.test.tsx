/* oxlint-disable typescript/no-unsafe-type-assertion -- test mocks
   intentionally widen the function-intersection MessageSender shape to a
   single-signature implementation; runtime behavior is unaffected. */
import { renderHook } from '@testing-library/react'
import { Effect, Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'
import * as fc from 'fast-check'
import { describe, expect, test, vi } from 'vite-plus/test'
import {
  HostMessagingProvider,
  useHostMessagingContext,
  type HostMessagingProviderProps,
} from '../src/host-messaging-context.tsx'

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
const testBridges: TestBridges = [NavigationBridge, GatekeeperBridge] as const

const recordingSendMessage = (
  sink: Array<{ readonly _tag: string }>
): Bridge.MessageSender<TestBridges, 'Host'> =>
  ((message: { readonly _tag: string }): Effect.Effect<void> =>
    Effect.sync(() => {
      sink.push(message)
    })) as unknown as Bridge.MessageSender<TestBridges, 'Host'>

const renderWithProvider = <Bridges extends ReadonlyArray<Bridge.AnyBridge>>(
  props: Omit<HostMessagingProviderProps<Bridges>, 'children'>
): ReturnType<typeof renderHook<ReturnType<typeof useHostMessagingContext>, void>> =>
  renderHook(useHostMessagingContext, {
    wrapper: ({ children }) => <HostMessagingProvider {...props}>{children}</HostMessagingProvider>,
  })

describe('useHostMessagingContext', () => {
  test('throws when called outside <HostMessagingProvider>', () => {
    // Silence the React error boundary log noise that accompanies the throw.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => renderHook(useHostMessagingContext)).toThrow(/must be called under/)
    consoleError.mockRestore()
  })

  test('exposes the provider-mounted bridges tuple on the context', () => {
    const { result } = renderWithProvider<TestBridges>({
      bridges: testBridges,
      sendMessage: recordingSendMessage([]),
    })
    expect(result.current.bridges).toBe(testBridges)
  })
})

describe('HostMessagingProvider.sendHostEffect', () => {
  test('returns an Effect that forwards the message to the underlying sendMessage', async () => {
    const received: Array<{ readonly _tag: string }> = []
    const { result } = renderWithProvider<TestBridges>({
      bridges: testBridges,
      sendMessage: recordingSendMessage(received),
    })

    // Variable form avoids TS excess-property check on the literal — slice
    // hooks would narrow the param type instead.
    const navMessage = { _tag: 'HostRequestedWebNavigation' as const, path: '/x' }
    await Effect.runPromise(result.current.sendHostEffect(navMessage))
    expect(received).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/x' }])
  })

  test('preserves message tags and payloads across arbitrary inputs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ _tag: fc.constant('HostBackRequested' as const) }),
            fc.record({
              _tag: fc.constant('HostRequestedWebNavigation' as const),
              path: fc.string(),
            }),
            fc.record({ _tag: fc.constant('AuthTokenIssued' as const), token: fc.string() })
          ),
          { minLength: 0, maxLength: 8 }
        ),
        async (messages) => {
          const received: Array<{ readonly _tag: string }> = []
          const { result } = renderWithProvider<TestBridges>({
            bridges: testBridges,
            sendMessage: recordingSendMessage(received),
          })
          await Effect.runPromise(
            Effect.forEach(messages, (msg) => result.current.sendHostEffect(msg), {
              discard: true,
            })
          )
          expect(received).toEqual(messages)
        }
      ),
      { numRuns: 25 }
    )
  })
})

describe('HostMessagingProvider.sendHost', () => {
  test('fire-and-forget: runs the underlying Effect without the caller awaiting', async () => {
    const calls: Array<{ readonly _tag: string }> = []
    const { result } = renderWithProvider<TestBridges>({
      bridges: testBridges,
      sendMessage: recordingSendMessage(calls),
    })

    result.current.sendHost({ _tag: 'HostBackRequested' })
    // Effect.runFork schedules synchronously; the Effect body (an Effect.sync)
    // runs on the same microtask tick. One queueMicrotask resolves it.
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve)
    })
    expect(calls).toEqual([{ _tag: 'HostBackRequested' }])
  })
})
