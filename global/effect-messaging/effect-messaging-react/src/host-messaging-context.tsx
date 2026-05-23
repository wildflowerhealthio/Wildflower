/* oxlint-disable react/only-export-components -- HostMessagingProvider
   and useHostMessagingContext share the same private context; splitting
   them would force a cross-file import of an otherwise-private context
   just to satisfy fast-refresh's "only components" rule. */
import { Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import { createContext, useContext, useMemo, type JSX, type ReactNode } from 'react'

/**
 * Erased-bridges view of a host-message sender. The provider closes
 * over a concrete `Bridge.MessageSender<Bridges, 'Host'>` (which is a
 * function-intersection over each bridge's typed sender) and exposes
 * a single-signature wrapper so the React context can hold one value
 * shape. Slice hooks restore per-bridge input narrowing at their own
 * return type via function-parameter contravariance — no cast at the
 * slice level.
 *
 * @remarks
 * Direct callers (e.g. tests) hitting these signatures with a typed
 * literal may trip TS's excess-property check; pass via a variable
 * (or call through a slice hook's narrowed return type) to bypass it.
 * Runtime dispatch happens by `_tag` inside the underlying
 * `Bridge.MessageSender` — see `bridge-transport.ts:286`.
 */
type AnyHostSendEffect = (message: { readonly _tag: string }) => Effect.Effect<void>

type AnyHostSend = (message: { readonly _tag: string }) => void

/**
 * Value carried by the host-messaging context.
 *
 * @remarks
 * `bridges` is exposed so per-slice hooks can fail-fast at first call
 * when the provider was mounted without their bridge (e.g. an app
 * that uses GatekeeperBridge but not CollectorBridge calling
 * `useCollectorHostMessaging`).
 */
interface HostMessagingContextValue {
  readonly bridges: ReadonlyArray<Bridge.AnyBridge>
  readonly sendHostEffect: AnyHostSendEffect
  readonly sendHost: AnyHostSend
}

const HostMessagingContext = createContext<HostMessagingContextValue | null>(null)

interface HostMessagingProviderProps<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly bridges: Bridges
  readonly sendMessage: Bridge.MessageSender<Bridges, 'Host'>
  readonly children: ReactNode
}

/**
 * Provides a host-side message sender to subtree consumers. Pairs with
 * {@link useHostMessagingContext} and per-slice narrowing hooks like
 * `useNavigationHostMessaging`. Each slice's hook reads this context,
 * verifies its bridge is registered, and exposes a `send` / `sendEffect`
 * narrowed to that bridge's `HostToWeb` messages.
 *
 * @remarks
 * Internally widens the concrete `Bridge.MessageSender<Bridges, 'Host'>`
 * function-intersection to a single-signature runtime wrapper via an
 * `as unknown as` cast — the same trick `bridge-transport.ts:286` uses
 * to populate `senderByTag`. Runtime dispatches by `_tag`; the cast
 * just papers over the function-intersection so subtree consumers
 * receive one stable shape.
 */
const HostMessagingProvider = <Bridges extends ReadonlyArray<Bridge.AnyBridge>>({
  bridges,
  sendMessage,
  children,
}: HostMessagingProviderProps<Bridges>): JSX.Element => {
  const value = useMemo<HostMessagingContextValue>(() => {
    // The function-intersection has incompatible parameter types per
    // overload, so TS won't let us call it directly with a wide message.
    // Widen via an `as unknown as` chain — runtime dispatch by `_tag`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const widenedSend = sendMessage as unknown as AnyHostSendEffect
    return {
      bridges,
      sendHostEffect: widenedSend,
      sendHost: (message): void => {
        Effect.runFork(widenedSend(message))
      },
    }
  }, [bridges, sendMessage])

  return <HostMessagingContext.Provider value={value}>{children}</HostMessagingContext.Provider>
}

/**
 * Read the host messaging context. Throws when called outside a
 * {@link HostMessagingProvider} — the fail-fast policy per-slice hooks
 * extend with their own bridge-presence check.
 */
const useHostMessagingContext = (): HostMessagingContextValue => {
  const ctx = useContext(HostMessagingContext)
  if (ctx === null) {
    throw new Error(
      '[effect-messaging-react] useHostMessagingContext: must be called under <HostMessagingProvider>'
    )
  }
  return ctx
}

export { HostMessagingProvider, useHostMessagingContext }
export type { HostMessagingContextValue, HostMessagingProviderProps }
