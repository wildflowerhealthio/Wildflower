import { Effect } from 'effect'
import type { Bridge, BridgeTransport } from 'effect-messaging-core'

interface RecordingSender<B extends ReadonlyArray<Bridge.AnyBridge>, Dir extends Bridge.Direction> {
  readonly sender: BridgeTransport.MessageSender<B, Dir>
  readonly received: ReadonlyArray<{ readonly _tag: string }>
}

/**
 * Build a typed recording sender for tests. Captures every message handed to
 * it into `received` in order. The single-signature thunk is widened to the
 * function-intersection `Bridge.TransportMessageSender` shape — the same widening the
 * production `makeMessaging` factory performs internally; runtime dispatches
 * by `_tag` so the cast is safe.
 */
const makeRecordingSender = <
  B extends ReadonlyArray<Bridge.AnyBridge>,
  Dir extends Bridge.Direction,
>(): RecordingSender<B, Dir> => {
  const received: Array<{ readonly _tag: string }> = []
  const thunk = (message: { readonly _tag: string }): Effect.Effect<void> =>
    Effect.sync(() => {
      received.push(message)
    })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const sender = thunk as unknown as BridgeTransport.MessageSender<B, Dir>
  return { sender, received }
}

export { makeRecordingSender }
export type { RecordingSender }
