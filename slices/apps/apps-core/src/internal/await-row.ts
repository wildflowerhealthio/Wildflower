import type { LiveQueryDef } from '@livestore/livestore'
import { Duration, Effect, Schema } from 'effect'
import { AppsStore } from '../contexts/apps-store.ts'

const DEFAULT_TIMEOUT: Duration.Duration = Duration.seconds(5)

class MaterialisationTimedOut extends Schema.TaggedError<MaterialisationTimedOut>()(
  'MaterialisationTimedOut',
  {
    label: Schema.String,
  }
) {}

/**
 * Suspend until a LiveStore row matching `predicate` appears (or already
 * exists), or the timeout elapses. Subscribes through `store.subscribe`,
 * disposing on success, timeout, and interruption.
 *
 * Useful when a handler commits one or more events and the response
 * shape depends on the merged row state. Modeled on `gatekeeper-core`'s
 * `await-row.ts`. Belongs in a shared utility if a second slice picks
 * it up — extracted later, not now.
 *
 * @example
 * ```ts
 * yield* awaitRow(
 *   AppSelection.queries.byId$(id),
 *   (row) => row.customName === expectedName,
 *   `appSelection/${id}`
 * )
 * ```
 */
const awaitRow = <A>(
  query: LiveQueryDef<A | undefined>,
  predicate: (row: A) => boolean,
  label: string,
  timeout: Duration.Duration = DEFAULT_TIMEOUT
): Effect.Effect<A, MaterialisationTimedOut, AppsStore> =>
  Effect.gen(function* () {
    const store = yield* AppsStore
    return yield* Effect.async<A, MaterialisationTimedOut>((resume) => {
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
        duration: timeout,
        onTimeout: () => new MaterialisationTimedOut({ label }),
      })
    )
  })

export { awaitRow, MaterialisationTimedOut, DEFAULT_TIMEOUT }
