import { Context, type Effect } from 'effect'

/** Writes one encoded message string to the underlying transport. */
type BareSenderFunction = (encoded: string) => Effect.Effect<void>

interface BareSenderService {
  /** Send one already-encoded string to the other process. */
  readonly bareSender: BareSenderFunction
}

class BareSender extends Context.Tag('@effect-messaging/BareSender')<
  BareSender,
  BareSenderService
>() {}

export { BareSender }
export type { BareSenderFunction, BareSenderService }
