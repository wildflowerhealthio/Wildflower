import { Context, type Effect } from 'effect'

/** Writes one encoded message string to the underlying transport. */
type BareSenderFunction = (encoded: string) => Effect.Effect<void>

/**
 * Shape provided at the {@link BareSender} tag — a single `bareSender`
 * function for emitting one encoded message string to the peer process.
 */
interface BareSenderService {
  /** Send one already-encoded string to the other process. */
  readonly bareSender: BareSenderFunction
}

/**
 * `Context.Tag` providing a {@link BareSenderService} — a single-shot
 * encoded-string sender for the underlying transport. Satisfied by the
 * platform transport adapter layer (see `transport-adapter.ts` and the
 * per-platform wiring sites such as `BridgedWebView` / the web
 * equivalents). Consumers `yield*` it inside handler effects whose
 * requirements include this tag (typically wired in through
 * `BridgeTransport.make`) to obtain the `bareSender` function.
 */
class BareSender extends Context.Tag('@effect-messaging/BareSender')<
  BareSender,
  BareSenderService
>() {}

export { BareSender }
export type { BareSenderFunction, BareSenderService }
