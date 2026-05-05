import type { LiveQueryDef } from '@livestore/livestore'
import { Duration, Effect, Schema } from 'effect'
import { GatekeeperStore } from '../contexts/GatekeeperStore.ts'

const GATE_TIMEOUT: Duration.Duration = Duration.minutes(5)

class ApprovalTimedOut extends Schema.TaggedError<ApprovalTimedOut>()('ApprovalTimedOut', {
  id: Schema.String,
}) {}

/**
 * Suspend until a LiveStore row matching `predicate` appears (or already
 * exists), or {@link GATE_TIMEOUT} elapses. The subscription is disposed on
 * success, timeout, and interruption.
 *
 * Designed for the out-of-band approval gate: the caller commits an event to
 * record the request, then awaits a state transition driven by an
 * out-of-band approver — without holding any in-memory listener registry.
 */
const waitForRow = <A>(
  query: LiveQueryDef<A | null | undefined>,
  predicate: (row: A) => boolean,
  id: string
): Effect.Effect<A, ApprovalTimedOut, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    return yield* Effect.async<A, ApprovalTimedOut>((resume) => {
      let disposed = false
      const dispose = store.subscribe(query, (row) => {
        if (disposed) return
        if (row != null && predicate(row)) {
          disposed = true
          dispose()
          resume(Effect.succeed(row))
        }
      })
      return Effect.sync(() => {
        if (!disposed) {
          disposed = true
          dispose()
        }
      })
    }).pipe(
      Effect.timeoutFail({
        duration: GATE_TIMEOUT,
        onTimeout: () => new ApprovalTimedOut({ id }),
      })
    )
  })

export { waitForRow, ApprovalTimedOut, GATE_TIMEOUT }
