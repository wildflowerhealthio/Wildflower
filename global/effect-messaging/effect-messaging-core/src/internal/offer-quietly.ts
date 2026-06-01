import { Effect, Queue } from 'effect'

/**
 * Offer one item to a queue, swallowing the post-shutdown failure.
 *
 * @remarks
 * After scope close the queue is shut down and a further `Queue.offer`
 * fails with an *interrupt cause* (not a typed error). `Effect.ignore`
 * only recovers the typed-error channel, so it would let the interrupt
 * through; `catchAllCause` swallows it, making a late offer a clean
 * no-op. Used for both the inbox (`enqueue`) and outbox (`sendMessage`)
 * — a send/enqueue racing scope close should never surface to the caller.
 */
const offerQuietly = <A>(queue: Queue.Enqueue<A>, item: A): Effect.Effect<void> =>
  Queue.offer(queue, item).pipe(Effect.catchAllCause(() => Effect.void))

export { offerQuietly }
