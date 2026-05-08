import { Context, Layer } from 'effect'
import {
  type GatekeeperNativeToWeb,
  type GatekeeperWebToNative,
} from 'gatekeeper-core/message-schemas'
import { type MessageHandler } from 'interop-core'

/**
 * Expo-side {@link MessageHandler} typed for the gatekeeper slice's two
 * directional records — the directions are swapped relative to
 * {@link GatekeeperWebMessageHandler}: the Expo handler *sends*
 * `AuthTokenIssued` (Native→Web) and would *receive* any Web→Native
 * messages the slice eventually adds.
 */
class GatekeeperExpoMessageHandler extends Context.Tag('GatekeeperExpoMessageHandler')<
  GatekeeperExpoMessageHandler,
  MessageHandler<GatekeeperWebToNative, GatekeeperNativeToWeb>
>() {}

const makeGatekeeperExpoMessageHandlerLayer = (
  handler: MessageHandler<GatekeeperWebToNative, GatekeeperNativeToWeb>
): Layer.Layer<GatekeeperExpoMessageHandler> => Layer.succeed(GatekeeperExpoMessageHandler, handler)

export { GatekeeperExpoMessageHandler, makeGatekeeperExpoMessageHandlerLayer }
