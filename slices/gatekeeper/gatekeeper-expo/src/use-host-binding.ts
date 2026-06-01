import { Effect, Fiber, pipe } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import { HostBindings } from 'effect-messaging-core'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { useEffect, useMemo, useRef, useState } from 'react'

interface UseGatekeeperHostBindingOptions {
  readonly token?: string
}

type GatekeeperSender = BridgeTransport.MessageSender<readonly [typeof GatekeeperBridge], 'Host'>

/**
 * Host binding for the gatekeeper bridge.
 *
 * The bearer token is deliberately kept off the WebView URL and instead
 * delivered through `onTransportReady`'s captured sender so it never
 * appears in WebView URL logs.
 *
 * @remarks
 * Binding identity is **stable** across `token` transitions: the
 * `useMemo` deps are empty and `onTransportReady` only captures the
 * sender into a ref. Token delivery is driven by a post-mount
 * `useEffect` that runs `AuthTokenIssued` once both transport-ready
 * and token-available are true. This eliminates the cold-start
 * double-build flash (transport torn down + rebuilt + WebView reload)
 * that the previous `[token]`-keyed memo caused when the host's token
 * minted after the initial render.
 *
 * Token rotation now flows the new value through the same effect
 * without a rebuild — the SPA receives a fresh `AuthTokenIssued` over
 * the live transport instead of remounting. To preserve ordering
 * under rapid rotation, each new send chains on `Fiber.await` of the
 * previous send fiber (held in {@link sendFiberRef}) before forking —
 * so an interrupted predecessor finalises before the successor starts
 * `postMessage`, preventing out-of-order writes to the page-side ref.
 */
const useGatekeeperHostBinding = ({
  token,
}: UseGatekeeperHostBindingOptions = {}): HostBindings.HostBindings<
  readonly [typeof GatekeeperBridge]
> => {
  const senderRef = useRef<GatekeeperSender | null>(null)
  const sendFiberRef = useRef<Fiber.RuntimeFiber<unknown, unknown> | null>(null)
  const [transportReady, setTransportReady] = useState(false)

  useEffect(() => {
    if (!transportReady || token === undefined) return undefined
    const send = senderRef.current
    if (send === null) return undefined
    const previousFiber = sendFiberRef.current
    // Wait the previous fiber's exit (success, failure, or interrupt)
    // before starting the next send, so rapid token rotations dispatch
    // in declared order even if the prior send hadn't finished its
    // postMessage when React fired this effect.
    const program = pipe(
      previousFiber === null ? Effect.void : Fiber.await(previousFiber),
      Effect.zipRight(send({ _tag: 'AuthTokenIssued', token }))
    )
    const fiber = Effect.runFork(program)
    sendFiberRef.current = fiber
    return (): void => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [token, transportReady])

  return useMemo(
    () =>
      HostBindings.single({
        bridge: GatekeeperBridge,
        receiverLayer: GatekeeperBridge.Host.ReceiverLayer({}),
        initialMessages: [],
        onTransportReady: (send: GatekeeperSender) =>
          Effect.sync(() => {
            senderRef.current = send
            setTransportReady(true)
          }),
      }),
    []
  )
}

export { useGatekeeperHostBinding }
export type { UseGatekeeperHostBindingOptions }
