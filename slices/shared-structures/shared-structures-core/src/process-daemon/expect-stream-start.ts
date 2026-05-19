import { Cause, Effect, Exit, Option, Scope, Sink, Stream } from 'effect'

import type { StreamStartResult } from './types.ts'

/**
 * Peel the first emit from `startProcess`'s stream as the "bind signal".
 *
 * The producer's `acquireRelease` resources are bound to the supplied
 * `scope` via `Scope.extend`, so closing the scope on reconfigure /
 * stop releases them and interrupts the tail. A pre-bind failure (the
 * peel effect failing) or a stream that completes without ever emitting
 * are both folded into `Failed` — the empty-stream case becomes a
 * defect cause (`Cause.die`) so callers don't need a third tag to triage.
 *
 * Caller decides whether to close `scope` based on the result tag —
 * `Started` keeps it open (the tail still lives inside it); `Failed`
 * expects the caller to close it.
 */
const expectStreamStart = <TStatus, E>(
  stream: Stream.Stream<TStatus, E, Scope.Scope>,
  scope: Scope.CloseableScope
): Effect.Effect<StreamStartResult<TStatus, E>> =>
  Effect.gen(function* () {
    const peeled = yield* Effect.exit(
      Scope.extend(Stream.peel(stream, Sink.head<TStatus>()), scope)
    )
    if (Exit.isFailure(peeled)) {
      return { _tag: 'Failed', cause: peeled.cause }
    }
    const [headOption, tailStream] = peeled.value
    if (Option.isNone(headOption)) {
      return {
        _tag: 'Failed',
        cause: Cause.die('startProcess stream ended without emitting a bind signal'),
      }
    }
    return { _tag: 'Started', status: headOption.value, statusStream: tailStream }
  })

export { expectStreamStart }
