import { type Effect } from 'effect'

/** Writes one encoded message string to the underlying transport. */
type BareSenderFunction = (encoded: string) => Effect.Effect<void>

export type { BareSenderFunction }
