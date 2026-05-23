import type { Bridge } from 'effect-messaging-core'

import {
  makeHoistedMessageSender,
  type MadeHoistedMessageSender,
} from './make-hoisted-message-sender.tsx'
import { makeMessageReceiver, type MadeMessageReceiver } from './make-message-receiver.tsx'
import { makeMessageSender, type MadeMessageSender } from './make-message-sender.tsx'

interface MakeMessaging<
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
>
  extends
    Omit<MadeMessageSender<TBridges, TSide>, 'Context'>,
    MadeHoistedMessageSender<TBridges, TSide>,
    MadeMessageReceiver<TBridges, TSide> {}

/**
 * Build a closed-over React surface for sending and receiving messages across
 * a known tuple of bridges, bound to one side of the wire.
 *
 * @example
 * ```ts
 * import { NavigationBridge } from 'navigation-core'
 * import { GatekeeperBridge } from 'gatekeeper-core'
 * import { makeMessaging } from 'effect-messaging-react'
 *
 * export const {
 *   MessageSenderProvider,
 *   useMessageSender,
 *   MessageReceiverProvider,
 *   useMessageReceiver,
 *   useMessageDispatcher,
 * } = makeMessaging([NavigationBridge, GatekeeperBridge] as const, 'Host')
 *
 * // Slice screen — send:
 * const { send } = useMessageSender(NavigationBridge)
 * send({ _tag: 'HostRequestedWebNavigation', path: '/apps' })
 *
 * // Slice screen — receive:
 * useMessageReceiver(NavigationBridge, {
 *   RouteChanged: (m) => Effect.sync(() => router.set(m.pathname)),
 * })
 * ```
 *
 * The factory composes three focused makers:
 *
 * - `makeMessageSender` — the regular sender provider + hook.
 * - `makeHoistedMessageSender` — a deferred-binding sender provider for trees
 *   where the transport mounts BELOW the consumer (RN-WebView on a sibling
 *   screen, etc.). Writes into the same sender context as the regular
 *   provider, so consumers don't need to know which provider is above them.
 * - `makeMessageReceiver` — receiver provider + per-tag handler hook +
 *   dispatcher. Multiple registrations for the same tag fan out.
 */
const makeMessaging = <
  const TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  const TSide extends 'Host' | 'Web',
>(
  bridges: TBridges,
  side: TSide
): MakeMessaging<TBridges, TSide> => {
  const sender = makeMessageSender(bridges, side)
  const hoisted = makeHoistedMessageSender(bridges, side, sender.Context)
  const receiver = makeMessageReceiver(bridges, side)
  return {
    MessageSenderProvider: sender.MessageSenderProvider,
    useMessageSender: sender.useMessageSender,
    HoistedMessageSenderProvider: hoisted.HoistedMessageSenderProvider,
    useRegisterMessageSender: hoisted.useRegisterMessageSender,
    MessageReceiverProvider: receiver.MessageReceiverProvider,
    useMessageReceiver: receiver.useMessageReceiver,
    useMessageDispatcher: receiver.useMessageDispatcher,
  }
}

export { makeMessaging }
export type { MakeMessaging }
