/**
 * Per-slice host-binding mock factories used by `app-shell-webview.test.tsx`.
 * Each factory returns a binding shape that's enough for the shell's
 * aggregation + `BridgedWebView` props assertions; the test's
 * `jest.mock(...)` factories call into these via `jest.requireActual`
 * to centralise the shape.
 *
 * `jest.mock` itself can't move out of the test file — its factory body
 * is hoisted above all imports per file, so a "single
 * `installAppShellBindingMocks()`" can't legally wire the mocks from
 * here. The factories below handle the binding shape, the test file
 * keeps the (necessarily file-scoped) `jest.mock` registrations.
 */
import { Effect, Layer } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import type { NavigationBridge } from 'navigation-core'

interface BindingShape<TName extends string> {
  readonly bridge: { readonly name: TName }
  readonly receiverLayer: Layer.Layer<never>
  readonly initialMessages?: ReadonlyArray<unknown>
}

const fakeReceiverLayer = (): Layer.Layer<never> => Layer.effectDiscard(Effect.void)

type NavigationOnTransportReady = (
  send: BridgeTransport.MessageSender<readonly [typeof NavigationBridge], 'Host'>
) => Effect.Effect<void>

interface NavigationMockOptions {
  readonly initialRoute?: string
  readonly onTransportReady?: NavigationOnTransportReady
}

const makeNavigationMock = (
  options: NavigationMockOptions
): BindingShape<'Navigation'> & {
  readonly onTransportReady?: NavigationOnTransportReady
} => ({
  bridge: { name: 'Navigation' as const },
  receiverLayer: fakeReceiverLayer(),
  initialMessages:
    options.initialRoute === undefined
      ? undefined
      : [{ _tag: 'HostRequestedWebNavigation' as const, path: options.initialRoute }],
  ...(options.onTransportReady === undefined ? {} : { onTransportReady: options.onTransportReady }),
})

interface GatekeeperMockOptions {
  readonly token?: string
}

type GatekeeperSendCallback<R> = (msg: {
  readonly _tag: 'AuthTokenIssued'
  readonly token: string
}) => Effect.Effect<void, never, R>

const makeGatekeeperMock = (
  options: GatekeeperMockOptions = {}
): BindingShape<'Gatekeeper'> & {
  readonly onTransportReady?: <R>(send: GatekeeperSendCallback<R>) => Effect.Effect<void, never, R>
} => {
  const token = options.token
  return {
    bridge: { name: 'Gatekeeper' as const },
    receiverLayer: fakeReceiverLayer(),
    initialMessages: [],
    onTransportReady:
      token === undefined
        ? undefined
        : <R>(send: GatekeeperSendCallback<R>): Effect.Effect<void, never, R> =>
            send({ _tag: 'AuthTokenIssued', token }),
  }
}

const makeCollectorMock = (): BindingShape<'Collector'> => ({
  bridge: { name: 'Collector' as const },
  receiverLayer: fakeReceiverLayer(),
})

const makeAppsMock = (): BindingShape<'Apps'> => ({
  bridge: { name: 'Apps' as const },
  receiverLayer: fakeReceiverLayer(),
})

const makeLogMock = (): BindingShape<'Log'> => ({
  bridge: { name: 'Log' as const },
  receiverLayer: fakeReceiverLayer(),
})

export { makeAppsMock, makeCollectorMock, makeGatekeeperMock, makeLogMock, makeNavigationMock }
export type { GatekeeperMockOptions, GatekeeperSendCallback, NavigationMockOptions }
