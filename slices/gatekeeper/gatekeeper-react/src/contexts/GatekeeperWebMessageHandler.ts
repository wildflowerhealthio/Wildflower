import { Context, Layer } from 'effect'
import {
  type GatekeeperNativeToWeb,
  type GatekeeperWebToNative,
} from 'gatekeeper-core/message-schemas'
import { type MessageHandler } from 'interop-core'

/**
 * Web-side {@link MessageHandler} typed for the gatekeeper slice's two
 * directional records — receives Native→Web (e.g. `AuthTokenIssued`),
 * sends Web→Native (currently empty).
 *
 * The aggregator in `apps/wildflower-react` constructs a single underlying
 * web handler covering all slices' combined direction records and supplies
 * it here via {@link makeGatekeeperWebMessageHandlerLayer}; the type system
 * narrows each slice's view to its own messages automatically.
 */
class GatekeeperWebMessageHandler extends Context.Tag('GatekeeperWebMessageHandler')<
  GatekeeperWebMessageHandler,
  MessageHandler<GatekeeperNativeToWeb, GatekeeperWebToNative>
>() {}

const makeGatekeeperWebMessageHandlerLayer = (
  handler: MessageHandler<GatekeeperNativeToWeb, GatekeeperWebToNative>
): Layer.Layer<GatekeeperWebMessageHandler> => Layer.succeed(GatekeeperWebMessageHandler, handler)

export { GatekeeperWebMessageHandler, makeGatekeeperWebMessageHandlerLayer }
