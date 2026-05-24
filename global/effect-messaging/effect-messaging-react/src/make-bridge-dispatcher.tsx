/* oxlint-disable react/only-export-components -- the provider and the hooks
   share an in-file registry context; splitting them would force a cross-file
   import of an otherwise-private context just to satisfy fast-refresh's rule. */
import { Effect } from 'effect'
import type { Bridge, BridgeTransport } from 'effect-messaging-core'
import { createContext, useCallback, useEffect, useRef, type FC, type RefObject } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

/** Per-bridge handler record for `useMessageReceiver`. */
type ReceiverHandlers<B extends Bridge.AnyBridge, TSide extends 'Host' | 'Web'> = Partial<{
  readonly [Tag in Bridge.SendableMessage<readonly [B], Bridge.OppositeSide<TSide>>['_tag']]: (
    message: Extract<
      Bridge.SendableMessage<readonly [B], Bridge.OppositeSide<TSide>>,
      { readonly _tag: Tag }
    >
  ) => Effect.Effect<void>
}>

interface MadeBridgeDispatcher<
  TName extends string,
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
> {
  readonly BridgeDispatchRegistryProvider: FC<React.PropsWithChildren> & {
    displayName: `${TName}BridgeDispatchRegistryProvider`
  }
  readonly useAsMessageHandlers: <B extends TBridges[number]>(
    handlers: ReceiverHandlers<B, TSide>
  ) => void
  readonly useMessageSender: () => BridgeTransport.MessageSender<
    TBridges,
    Bridge.OppositeSide<TSide>
  >
}

/**
 * Build a receiver provider + hook + dispatcher trio bound to a known bridge
 * tuple and side.
 *
 * Multiple registrations for the same tag fan out — every registered handler
 * runs for each inbound message of that tag. Handlers register on mount and
 * deregister on unmount. Pass stable callbacks (`useCallback`) or memoize the
 * `handlers` object to avoid re-register cycles on every render.
 *
 * The transport-mounting code calls `useAsMessageHandlers` and feeds inbound
 * messages into the registered handlers.
 */
const makeBridgeDispatcher = <
  const TName extends string,
  const TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  const TSide extends 'Host' | 'Web',
>(
  name: TName,
  _bridges: TBridges,
  _side: TSide
): MadeBridgeDispatcher<TName, TBridges, TSide> => {
  type Inbound = Extract<
    Bridge.SendableMessage<TBridges, Bridge.OppositeSide<TSide>>,
    { readonly _tag: string }
  >
  type AnyHandler = (message: Inbound) => Effect.Effect<void>
  type Registry = Map<string, Set<AnyHandler>>

  const RegistryContext = createContext<RefObject<Registry> | null>(null)
  RegistryContext.displayName = `${name}BridgeDispatchRegistryContext`

  const BridgeDispatchRegistryProvider: FC<React.PropsWithChildren> = ({ children }) => {
    const registryRef = useRef<Registry>(new Map())
    return <RegistryContext.Provider value={registryRef}>{children}</RegistryContext.Provider>
  }
  BridgeDispatchRegistryProvider.displayName = `${name}BridgeDispatchRegistryProvider`

  // `bridge` is a type witness — its `OppositeSide` outbound schema set is what
  // narrows the handler signatures. The hook only touches tags present in
  // `handlers`.
  const useAsMessageHandlers = <B extends TBridges[number]>(
    handlers: ReceiverHandlers<B, TSide>
  ): void => {
    const ref = useContextOrThrow(RegistryContext)
    useEffect((): (() => void) => {
      const registry = ref.current
      const added: Array<readonly [string, AnyHandler]> = []
      for (const [tag, handler] of Object.entries(handlers)) {
        if (handler === undefined) continue
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const h = handler as unknown as AnyHandler
        const existing = registry.get(tag) ?? new Set<AnyHandler>()
        existing.add(h)
        registry.set(tag, existing)
        added.push([tag, h])
      }
      return (): void => {
        for (const [tag, h] of added) {
          registry.get(tag)?.delete(h)
        }
      }
    }, [ref, handlers])
  }

  const useMessageSender = (): ((message: Inbound) => Effect.Effect<void>) => {
    const ref = useContextOrThrow(RegistryContext)
    return useCallback(
      (message: Inbound): Effect.Effect<void> =>
        Effect.suspend(() => {
          const tag = (message as { readonly _tag: string })._tag
          const handlers = ref.current.get(tag)
          if (handlers === undefined || handlers.size === 0) {
            return Effect.logDebug(
              `[effect-messaging] no receivers registered for "${tag}"; dropping`
            )
          }
          return Effect.forEach([...handlers], (h) => h(message), { discard: true })
        }),
      [ref]
    )
  }

  return {
    BridgeDispatchRegistryProvider:
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      BridgeDispatchRegistryProvider as FC<React.PropsWithChildren> & {
        displayName: `${TName}BridgeDispatchRegistryProvider`
      },
    useAsMessageHandlers,
    useMessageSender,
  }
}

export { makeBridgeDispatcher }
export type { MadeBridgeDispatcher }
