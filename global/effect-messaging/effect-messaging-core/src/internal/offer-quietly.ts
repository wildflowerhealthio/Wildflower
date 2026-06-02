import { Cause, Effect, Queue } from 'effect'

/**
 * Offer one item to a queue, swallowing the post-shutdown interrupt.
 *
 * @remarks
 * After scope close the queue is shut down and a further `Queue.offer`
 * fails with an *interrupt cause* (not a typed error). `Effect.ignore`
 * only recovers the typed-error channel, so it would let the interrupt
 * through; we narrow `catchAllCause` to interrupts so a real defect
 * (programming bug in `Queue.offer`, future non-interrupt Queue failure)
 * still surfaces. Used for both the inbox (`enqueue`) and outbox
 * (`sendMessage`) — a send/enqueue racing scope close should never
 * surface to the caller, but a genuine error should.
 */
const offerQuietly = <A>(queue: Queue.Enqueue<A>, item: A): Effect.Effect<void> =>
  Queue.offer(queue, item).pipe(
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause) ? Effect.void : Effect.failCause(cause)
    )
  )

export { offerQuietly }
