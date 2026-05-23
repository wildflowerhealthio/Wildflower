/* oxlint-disable react/only-export-components -- the provider and the hooks
   share an in-file registry context; splitting them would force a cross-file
   import of an otherwise-private context just to satisfy fast-refresh's rule. */
import { Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

import type { OppositeSide, ReceiverHandlers } from './types.ts'

interface MessageReceiverProviderProps {
  readonly children: ReactNode
}

interface MadeMessageReceiver<
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
> {
  readonly MessageReceiverProvider: (props: MessageReceiverProviderProps) => JSX.Element
  readonly useMessageReceiver: <B extends TBridges[number]>(
    bridge: B,
    handlers: ReceiverHandlers<B, TSide>
  ) => void
  readonly useMessageDispatcher: () => (
    message: Extract<
      Bridge.SendableMessage<TBridges, OppositeSide<TSide>>,
      { readonly _tag: string }
    >
  ) => Effect.Effect<void>
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
 * The transport-mounting code calls `useMessageDispatcher` and feeds inbound
 * messages into the returned function.
 */
const makeMessageReceiver = <
  const TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  const TSide extends 'Host' | 'Web',
>(
  _bridges: TBridges,
  _side: TSide
): MadeMessageReceiver<TBridges, TSide> => {
  type Inbound = Extract<
    Bridge.SendableMessage<TBridges, OppositeSide<TSide>>,
    { readonly _tag: string }
  >
  type AnyHandler = (message: Inbound) => Effect.Effect<void>
  type Registry = Map<string, Set<AnyHandler>>

  const RegistryContext = createContext<RefObject<Registry> | null>(null)
  RegistryContext.displayName = 'MessageReceiverRegistryContext'

  const MessageReceiverProvider = ({ children }: MessageReceiverProviderProps): JSX.Element => {
    const registryRef = useRef<Registry>(new Map())
    return <RegistryContext.Provider value={registryRef}>{children}</RegistryContext.Provider>
  }

  // `bridge` is a type witness — its `OppositeSide` outbound schema set is what
  // narrows the handler signatures. The hook only touches tags present in
  // `handlers`.
  const useMessageReceiver = <B extends TBridges[number]>(
    _bridge: B,
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

  const useMessageDispatcher = (): ((message: Inbound) => Effect.Effect<void>) => {
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

  return { MessageReceiverProvider, useMessageReceiver, useMessageDispatcher }
}

export { makeMessageReceiver }
export type { MadeMessageReceiver, MessageReceiverProviderProps }
