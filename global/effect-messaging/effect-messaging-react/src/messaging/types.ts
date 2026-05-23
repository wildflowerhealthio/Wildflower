import type { Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'

/** The opposite side of a bridge: messages we receive came from this side. */
type OppositeSide<S extends 'Host' | 'Web'> = S extends 'Host' ? 'Web' : 'Host'

/**
 * Bridge-narrowed messaging-sender surface for one side.
 *
 * - `send` — fire-and-forget. Forks the underlying Effect via `runFork` and
 *   pipes defects through `Effect.logError` so failures don't vanish.
 * - `sendEffect` — returns the Effect for callers composing inside other
 *   Effect programs.
 */
interface MessageSender<M extends { readonly _tag: string }> {
  readonly send: (message: M) => void
  readonly sendEffect: (message: M) => Effect.Effect<void>
}

/**
 * Internal context value held by the sender providers. The dispatcher is
 * widened to accept the union of every outbound message; per-bridge narrowing
 * is restored at `useMessageSender`'s return type via `B extends TBridges[number]`.
 */
interface SenderContextValue<
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
> {
  readonly sendEffect: (
    message: Extract<Bridge.SendableMessage<TBridges, TSide>, { readonly _tag: string }>
  ) => Effect.Effect<void>
}

/** Per-bridge handler record for `useMessageReceiver`. */
type ReceiverHandlers<B extends Bridge.AnyBridge, TSide extends 'Host' | 'Web'> = Partial<{
  readonly [Tag in Bridge.SendableMessage<readonly [B], OppositeSide<TSide>>['_tag']]: (
    message: Extract<
      Bridge.SendableMessage<readonly [B], OppositeSide<TSide>>,
      { readonly _tag: Tag }
    >
  ) => Effect.Effect<void>
}>

export type { MessageSender, OppositeSide, ReceiverHandlers, SenderContextValue }
