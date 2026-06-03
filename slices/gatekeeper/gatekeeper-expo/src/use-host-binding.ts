import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import { HostBindings } from 'effect-messaging-core'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { useEffect, useMemo, useRef } from 'react'

interface UseGatekeeperHostBindingOptions {
  readonly token?: string
}

type GatekeeperSender = BridgeTransport.MessageSender<
  readonly [typeof GatekeeperBridge],
  'HostToWeb'
>

/**
 * Host binding for the gatekeeper bridge.
 *
 * The bearer token is deliberately kept off the WebView URL and instead
 * delivered through `onPageReady`'s captured sender so it never appears
 * in WebView URL logs.
 *
 * @remarks
 * Binding identity is **stable** across `token` transitions: the
 * `useMemo` deps are empty. Two complementary delivery paths cover the
 * two ways a freshly-loaded SPA can need a token:
 *
 *  - **Every page (re)load** — `onPageReady` fires inside the host
 *    transport's `__Ready` control handler each time the page posts
 *    `__Ready` (first WebView mount, Metro reload, the
 *    `react-native-webview` Android blank-page workaround remount,
 *    `webviewRef.current?.reload()`, …). It captures the sender into a
 *    ref (idempotent across re-fires, identity is transport-stable) and
 *    pushes the *current* token if one is available. The ref read
 *    inside the callback is what keeps freshly-loaded pages
 *    authenticated even when the host's token hasn't transitioned.
 *  - **Token rotation while a page is live** — a `useEffect([token])`
 *    pushes the new token through the same captured sender when the
 *    host re-mints mid-session and the SPA is still up. Pre-page-ready
 *    rotations are absorbed by the `senderRef === null` short-circuit;
 *    the next `onPageReady` will pick the new value up via `tokenRef`.
 *
 * Eliminates the cold-start double-build flash (transport torn down +
 * rebuilt + WebView reload) that the previous `[token]`-keyed memo
 * caused when the host's token minted after the initial render, and
 * eliminates the blank-page-after-reload symptom that the previous
 * "fire onTransportReady only once per build" semantics caused when the
 * WebView remounted (page boots fresh, posts `__Ready`, but the host's
 * `transportReady`-gated effect never re-fired).
 *
 * Ordering under rapid rotation needs no fiber chaining: `send` offers
 * synchronously into the transport's single FIFO outbox (the one
 * ordering authority), so successive rotations dispatch in declared
 * order even if `onPageReady` and the rotation effect race.
 */
const useGatekeeperHostBinding = ({
  token,
}: UseGatekeeperHostBindingOptions = {}): HostBindings.HostBindings<
  readonly [typeof GatekeeperBridge]
> => {
  const senderRef = useRef<GatekeeperSender | null>(null)
  const tokenRef = useRef<string | undefined>(token)
  // Keep `tokenRef` aligned with the current `token` prop so a future
  // `onPageReady` re-fire (next WebView reload) reads the latest value
  // rather than the one captured the last time the binding was built.
  tokenRef.current = token

  // Token rotation while the page is up. The `senderRef === null`
  // short-circuit covers initial mount (the effect fires once on mount
  // with the prop value, but `onPageReady` hasn't installed the sender
  // yet) and any window where the WebView is mid-remount — those
  // rotations are picked up by the next `onPageReady` via `tokenRef`.
  useEffect(() => {
    if (token === undefined) return
    const send = senderRef.current
    if (send === null) {
      Effect.runFork(
        Effect.logDebug(
          '[gatekeeper-expo] token rotation observed but sender not yet captured; deferring to next onPageReady'
        )
      )
      return
    }
    Effect.runFork(
      Effect.logInfo(
        '[gatekeeper-expo] pushing AuthTokenIssued via rotation effect (token changed mid-session)'
      ).pipe(Effect.zipRight(send({ _tag: 'AuthTokenIssued', token })))
    )
  }, [token])

  return useMemo(
    () =>
      HostBindings.single({
        bridge: GatekeeperBridge,
        handlers: {},
        initialMessages: [],
        onPageReady: (send: GatekeeperSender) =>
          Effect.gen(function* () {
            senderRef.current = send
            const current = tokenRef.current
            if (current === undefined) {
              yield* Effect.logInfo(
                '[gatekeeper-expo] onPageReady fired; sender captured; no token to deliver yet'
              )
              return
            }
            yield* Effect.logInfo(
              '[gatekeeper-expo] onPageReady fired; pushing AuthTokenIssued to page'
            )
            yield* send({ _tag: 'AuthTokenIssued', token: current })
          }),
      }),
    []
  )
}

export { useGatekeeperHostBinding }
export type { UseGatekeeperHostBindingOptions }
