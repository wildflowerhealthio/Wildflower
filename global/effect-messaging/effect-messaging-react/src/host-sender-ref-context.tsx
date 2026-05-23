/* oxlint-disable react/only-export-components -- HoistedHostMessagingProvider
   and useRegisterHostSender share the same private context; splitting
   them would force a cross-file import of an otherwise-private context
   just to satisfy fast-refresh's "only components" rule. */

import { Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react'

import { HostMessagingProvider } from './host-messaging-context.tsx'

/**
 * Single-signature host→web sender. Mirrors the widened
 * `HostMessagingContextValue.sendHostEffect` shape — runtime dispatch
 * by `_tag` honors each bridge's typed sender.
 */
type HostSenderFn = (message: {
  readonly _tag: string
  readonly [key: string]: unknown
}) => Effect.Effect<void>

type HostSenderRef = RefObject<HostSenderFn | null>

const HostSenderRefContext = createContext<HostSenderRef | null>(null)

/**
 * Drop-in replacement for `<HostMessagingProvider>` whose `sendMessage`
 * resolves through a ref slot the subtree populates later. Use when
 * the tree that owns the live transport mounts BELOW the tree that
 * needs to send through it — e.g. a router `<Stack>` whose `index`
 * screen owns the WebView while a sibling modal screen needs to send
 * into it.
 *
 * The transport host (typically `BridgedWebView`) calls
 * {@link useRegisterHostSender} to write its `transport.sendMessage`
 * into the ref. Sends issued before any transport has registered warn
 * via `Effect.logWarning` and drop silently — symmetric with the
 * bridge transport's "no peer attached" semantics.
 */
interface HoistedHostMessagingProviderProps {
  readonly bridges: ReadonlyArray<Bridge.AnyBridge>
  readonly children: ReactNode
}

const HoistedHostMessagingProvider = ({
  bridges,
  children,
}: HoistedHostMessagingProviderProps): JSX.Element => {
  const senderRef = useRef<HostSenderFn | null>(null)
  const sendMessage = useCallback(
    (message: { readonly _tag: string; readonly [key: string]: unknown }): Effect.Effect<void> =>
      Effect.suspend(() => {
        const send = senderRef.current
        // DIAGNOSTIC: log every send attempt so we can confirm the
        // ref-indirected sender path actually fires when modal/sibling
        // trees attempt to forward host→web messages. Pair with the
        // per-event log in the consuming screens to track each event
        // through the chain.
        // oxlint-disable-next-line no-console -- intentional diagnostic surface
        console.log(
          `[HoistedHostMessagingProvider] send "${message._tag}" senderReady=${send !== null}`
        )
        if (send === null) {
          return Effect.logWarning(
            `[effect-messaging] host sender not registered yet; dropping "${message._tag}"`
          )
        }
        return send(message)
      }),
    []
  )
  // `HostMessagingProvider` is generic over its bridges tuple and
  // expects a function-intersection `sendMessage`. With the bridges
  // erased to `ReadonlyArray<Bridge.AnyBridge>` here, the inferred
  // intersection collapses to a permissive shape that still accepts
  // our single-signature thunk after the same widen cast used inside
  // `HostMessagingProvider` itself. Runtime dispatches by `_tag`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const widenedSend = sendMessage as unknown as Bridge.MessageSender<
    ReadonlyArray<Bridge.AnyBridge>,
    'Host'
  >
  return (
    <HostSenderRefContext.Provider value={senderRef}>
      <HostMessagingProvider bridges={bridges} sendMessage={widenedSend}>
        {children}
      </HostMessagingProvider>
    </HostSenderRefContext.Provider>
  )
}

/**
 * Register a transport's `sendMessage` into the nearest
 * {@link HoistedHostMessagingProvider}'s ref slot for the lifetime of
 * the calling component. Pass `null` while the transport is still
 * building; the wrapper re-registers on the next call.
 *
 * Safe to call without a surrounding provider — no-op. Callers
 * should widen their typed `Bridge.MessageSender<…, 'Host'>` through
 * `as unknown as HostSenderFn` (same trick used inside
 * `HostMessagingProvider`).
 */
const useRegisterHostSender = (sender: HostSenderFn | null): void => {
  const ref = useContext(HostSenderRefContext)
  useEffect((): (() => void) | undefined => {
    if (ref === null) return undefined
    ref.current = sender
    return (): void => {
      // Only clear if the slot still holds *our* sender — guards
      // against a stale unmount clobbering a later registrant's
      // sender if effects interleave during a remount.
      if (ref.current === sender) ref.current = null
    }
  }, [ref, sender])
}

export { HoistedHostMessagingProvider, useRegisterHostSender }
export type { HostSenderFn, HostSenderRef }
