import type { Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'

type Outbound<
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
> = Extract<Bridge.SendableMessage<TBridges, TSide>, { readonly _tag: string }>

/**
 * Widen the function-intersection `Bridge.MessageSender` to a single-signature
 * function whose input is the union of all outbound messages.
 *
 * Runtime dispatch lands every tag at its bridge's typed sender — see
 * `senderByTag` in `bridge.ts`. This cast is centralised here so the rest of
 * the factory never reaches for it; the runtime invariant is independently
 * pinned by the transport's `senderByTag` tests.
 */
const widen = <TBridges extends ReadonlyArray<Bridge.AnyBridge>, TSide extends 'Host' | 'Web'>(
  sendMessage: Bridge.MessageSender<TBridges, TSide>
): ((message: Outbound<TBridges, TSide>) => Effect.Effect<void>) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  sendMessage as unknown as (message: Outbound<TBridges, TSide>) => Effect.Effect<void>

export { widen }
export type { Outbound }
