import { type Effect } from 'effect'

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

export type { BareSenderFunction, BareSenderService }
