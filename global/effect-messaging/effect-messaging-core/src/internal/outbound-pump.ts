import type { Scope } from 'effect'
import { Array, Effect, Queue, Record, Stream } from 'effect'
import type * as Bridge from '../bridge.ts'
import * as Message from '../message.ts'
import type { TransportAdapterService } from '../transport-adapter.ts'
import { assertNoDuplicateTags } from './assert-no-duplicate-tags.ts'
import { offerQuietly } from './offer-quietly.ts'

/**
 * Typed outbound sender for every wired bridge — one function accepting
 * the union of decoded messages sendable in `OutDir`. The transport's
 * public `sendMessage` strips the {@link TransportAdapter} requirement.
 *
 * @remarks
 * `Bridges` appears only inside `SendableMessage`, a function-parameter
 * (contravariant) position, so no variance annotation is needed — TS
 * measures the contravariance and lets `callTransportReady` hand a
 * full-tuple sender to each narrow per-slot callback structurally.
 */
type MessageSender<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  OutDir extends Bridge.Direction,
> = (message: Bridge.SendableMessage<Bridges, OutDir>) => Effect.Effect<void>

/** Outbound half of the transport: encode → emit, behind one gated queue. */
interface OutboundPump<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  OutDir extends Bridge.Direction,
> {
  readonly sendMessage: MessageSender<Bridges, OutDir>
}

/**
 * Build the outbound pump: sends are offered to an unbounded outbox
 * immediately (never suspending the caller); a single forked fiber gates
 * once on `ready`, then drains the outbox forever, encoding each message
 * and handing the wire string to the adapter's bare sender.
 *
 * @remarks
 * `ready` is the send gate — `Deferred.await(peerReady)` on the host
 * (waits for the web's `__Ready`) and an already-open `Effect.void` on the
 * web. Buffered sends flush in order the moment the gate opens.
 *
 * An unowned tag is unreachable for any type-checking caller —
 * `SendableMessage` only admits owned tags. A type-escape (e.g. a cast)
 * lands as a loud `Effect.die`, which the per-message `catchAllDefect`
 * logs before the pump continues with the next message (mirroring the
 * inbound dispatch's defect handling) — one bad message never silently
 * stops the whole outbound path.
 */
const makeOutboundPump = <
  const Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  const OutDir extends Bridge.Direction,
>(config: {
  readonly bridges: Bridges
  readonly outboundDirection: OutDir
  readonly adapter: TransportAdapterService
  readonly ready: Effect.Effect<void>
}): Effect.Effect<OutboundPump<Bridges, OutDir>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { bridges, outboundDirection, adapter, ready } = config

    assertNoDuplicateTags(
      Array.flatMap(bridges, (bridge) => Record.keys(bridge[outboundDirection])),
      'outbound'
    )
    const outboundByTag: Record<string, Message.AnyStringEncodedSchema> = {}
    for (const bridge of bridges) {
      for (const [tag, schema] of Record.toEntries(bridge[outboundDirection])) {
        outboundByTag[tag] = schema
      }
    }

    const outbox = yield* Queue.unbounded<Bridge.SendableMessage<Bridges, OutDir>>()

    const sendMessage: MessageSender<Bridges, OutDir> = (
      message: Bridge.SendableMessage<Bridges, OutDir>
    ): Effect.Effect<void> => offerQuietly(outbox, message)

    yield* Effect.forkScoped(
      ready.pipe(
        Effect.andThen(
          Stream.runForEach(Stream.fromQueue(outbox, { shutdown: true }), (message) => {
            const emit =
              outboundByTag[message._tag] === undefined
                ? Effect.die(
                    new Error(
                      `[effect-messaging] sendMessage: no bridge owns tag "${message._tag}"`
                    )
                  )
                : adapter.bareSender(Message.stringifyMessage(outboundByTag, message))
            return emit.pipe(
              Effect.catchAllDefect((defect) =>
                Effect.logError(
                  `[effect-messaging] outbound pump defect; continues: ${String(defect)}`
                )
              )
            )
          })
        )
      )
    )

    return { sendMessage }
  })

export { makeOutboundPump }
export type { MessageSender, OutboundPump }
