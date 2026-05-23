/* oxlint-disable react/only-export-components -- `makeHostMessaging` returns
   the Provider components alongside hooks; the components are nested inside
   the factory closure (so they share its TBridges binding) and can't be
   split out into separate files. */
import { Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react'
import { NoContextException, useContextOrThrow } from 'react-kitchen-sink'

/**
 * Bridge-narrowed host-side messaging surface.
 *
 * - `send` — fire-and-forget. Forks the underlying Effect via `runFork`
 *   and pipes defects through `Effect.logError` so failures don't vanish.
 * - `sendEffect` — returns the Effect for callers composing inside other
 *   Effect programs.
 */
interface HostMessageSender<M extends { readonly _tag: string }> {
  readonly send: (message: M) => void
  readonly sendEffect: (message: M) => Effect.Effect<void>
}

interface MakeHostMessaging<TBridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly HostMessagingProvider: (props: HostMessagingProviderProps<TBridges>) => JSX.Element
  readonly HoistedHostMessagingProvider: (props: HoistedHostMessagingProviderProps) => JSX.Element
  readonly useRegisterHostSender: (sender: Bridge.MessageSender<TBridges, 'Host'> | null) => void
  readonly useHostMessageSender: <B extends TBridges[number]>(
    bridge: B
  ) => HostMessageSender<Bridge.SendableMessage<readonly [B], 'Host'>>
}

interface HostMessagingProviderProps<TBridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly sendMessage: Bridge.MessageSender<TBridges, 'Host'>
  readonly children: ReactNode
}

interface HoistedHostMessagingProviderProps {
  readonly children: ReactNode
}

/**
 * Build a closed-over React surface for sending host→web messages
 * across a known tuple of bridges. Returns a Provider, a deferred
 * (ref-indirected) Provider for trees where the transport mounts
 * below the consumer, a registration hook for the deferred variant,
 * and a per-bridge sender hook.
 *
 * @example
 * ```ts
 * const { HostMessagingProvider, useHostMessageSender } = makeHostMessaging([
 *   NavigationBridge,
 *   GatekeeperBridge,
 * ] as const)
 *
 * // Inside a slice screen:
 * const { send } = useHostMessageSender(NavigationBridge)
 * send({ _tag: 'HostRequestedWebNavigation', path: '/apps' })
 * ```
 */
const makeHostMessaging = <const TBridges extends ReadonlyArray<Bridge.AnyBridge>>(
  _bridges: TBridges
): MakeHostMessaging<TBridges> => {
  // `_bridges` is a type witness — the factory's whole purpose is to bind
  // `TBridges` into the returned closure so downstream types can flow
  // without runtime generics. The runtime dispatches by `_tag`.
  type Outbound = Extract<Bridge.SendableMessage<TBridges, 'Host'>, { readonly _tag: string }>
  type AnySender = (message: Outbound) => Effect.Effect<void>

  interface ContextValue {
    readonly sendEffect: AnySender
  }

  const HostMessagingContext = createContext<ContextValue | null>(null)
  HostMessagingContext.displayName = 'HostMessagingContext'

  const HoistedSenderRefContext = createContext<RefObject<Bridge.MessageSender<
    TBridges,
    'Host'
  > | null> | null>(null)
  HoistedSenderRefContext.displayName = 'HoistedHostSenderRefContext'

  // Widens the function-intersection `Bridge.MessageSender` to a single-
  // signature function whose input is the union of all outbound messages.
  // Runtime dispatch lands every tag at its bridge's typed sender — see
  // `senderByTag` in `bridge.ts`. Casted once here; consumer code never sees it.
  const widen = (sendMessage: Bridge.MessageSender<TBridges, 'Host'>): AnySender =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    sendMessage as unknown as AnySender

  const HostMessagingProvider = ({
    sendMessage,
    children,
  }: HostMessagingProviderProps<TBridges>): JSX.Element => {
    const value = useMemo<ContextValue>(() => ({ sendEffect: widen(sendMessage) }), [sendMessage])
    return <HostMessagingContext.Provider value={value}>{children}</HostMessagingContext.Provider>
  }

  const HoistedHostMessagingProvider = ({
    children,
  }: HoistedHostMessagingProviderProps): JSX.Element => {
    const senderRef = useRef<Bridge.MessageSender<TBridges, 'Host'> | null>(null)
    const sendMessage = useCallback(
      (message: Outbound): Effect.Effect<void> =>
        Effect.suspend(() => {
          const sender = senderRef.current
          if (sender === null) {
            const tag = (message as { readonly _tag: string })._tag
            return Effect.logWarning(
              `[effect-messaging] host sender not registered yet; dropping "${tag}"`
            )
          }
          return widen(sender)(message)
        }),
      []
    )
    const value = useMemo<ContextValue>(() => ({ sendEffect: sendMessage }), [sendMessage])
    return (
      <HoistedSenderRefContext.Provider value={senderRef}>
        <HostMessagingContext.Provider value={value}>{children}</HostMessagingContext.Provider>
      </HoistedSenderRefContext.Provider>
    )
  }

  const useRegisterHostSender = (sender: Bridge.MessageSender<TBridges, 'Host'> | null): void => {
    const ref = useContextOrThrow(HoistedSenderRefContext)
    useEffect((): (() => void) => {
      ref.current = sender
      return (): void => {
        if (ref.current === sender) ref.current = null
      }
    }, [ref, sender])
  }

  // `bridge` is a compile-time type witness — `B extends TBridges[number]`
  // narrows the returned sender to that bridge's outbound messages.
  // At runtime the surrounding provider dispatches by `_tag`; the bridge
  // identity is not consulted.
  const useHostMessageSender = <B extends TBridges[number]>(
    _bridge: B
  ): HostMessageSender<Bridge.SendableMessage<readonly [B], 'Host'>> => {
    const ctx = useContextOrThrow(HostMessagingContext)
    return useMemo(() => {
      type Narrow = Bridge.SendableMessage<readonly [B], 'Host'>
      const sendEffect = (message: Narrow): Effect.Effect<void> => ctx.sendEffect(message)
      const send = (message: Narrow): void => {
        Effect.runFork(sendEffect(message).pipe(Effect.tapErrorCause(Effect.logError)))
      }
      return { send, sendEffect }
    }, [ctx])
  }

  return {
    HostMessagingProvider,
    HoistedHostMessagingProvider,
    useRegisterHostSender,
    useHostMessageSender,
  }
}

export { makeHostMessaging, NoContextException }
export type { HostMessageSender, HostMessagingProviderProps, HoistedHostMessagingProviderProps }
