import type { ParseResult, Scope } from 'effect'
import {
  Array,
  Effect,
  Match,
  Option,
  ParseResult as ParseResultMod,
  pipe,
  Queue,
  Record,
  Schema,
  Stream,
} from 'effect'
import type * as Bridge from '../bridge.ts'
import type * as MessageHandler from '../message-handler.ts'
import type { TransportAdapterService } from '../transport-adapter.ts'
import type { HandlerRegistry } from './handler-registry.ts'
import { offerQuietly } from './offer-quietly.ts'

/**
 * Loose schema bound for members of the dispatch union. Each member is
 * a typeSchema'd `parseJson(TaggedStruct(...))` (i.e., `Schema<A, A>`
 * for some `A extends { _tag: string }`); the heterogeneous decoded
 * types collapse via `any` here, then re-narrow at the routing site
 * where we read `_tag` for the handler lookup.
 */
// oxlint-disable-next-line typescript/no-explicit-any
type AnyTaggedSchema = Schema.Schema<any, any, never>

/** Inbound half of the transport: decode → route, behind one FIFO queue. */
interface InboundDispatcher {
  /**
   * Push one raw inbound string into the dispatch fiber. After scope
   * close the call is a no-op (the queue is shut down).
   */
  readonly enqueue: (raw: string) => Effect.Effect<void>
}

/**
 * Build the inbound dispatcher: a single FIFO queue drained by one forked
 * fiber that decodes each raw string against the bridges' inbound schema
 * union and routes it to the registry's handler (logging-and-dropping
 * unknown tags / unhandled tags / decode failures).
 *
 * @remarks
 * `extraInboundSchemas` carries extra control-message schemas that get
 * merged into the dispatch union — the transport injects the `__Ready`
 * handshake schema this way so the dispatcher stays ignorant of
 * handshake semantics.
 */
const makeInboundDispatcher = <
  const Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  const InDir extends Bridge.Direction,
>(config: {
  readonly bridges: Bridges
  readonly inboundDirection: InDir
  readonly registry: HandlerRegistry<Bridges, InDir>
  readonly adapter: TransportAdapterService
  readonly extraInboundSchemas: ReadonlyArray<AnyTaggedSchema>
}): Effect.Effect<InboundDispatcher, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { bridges, inboundDirection, registry, adapter, extraInboundSchemas } = config

    // The bridges' inbound schemas may be empty for a transport with no
    // inbound traffic; appending `extraInboundSchemas` (the caller-injected
    // control-message schemas — non-empty in practice) keeps the union
    // non-empty even in that case. The cast re-imposes `NonEmptyArray`
    // because `Array.appendAll` doesn't preserve non-emptiness when the
    // left side's emptiness is unknown to the type system.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const innerSchemas = pipe(
      Array.flatMap(bridges, (bridge) => Record.values(bridge[inboundDirection])),
      Array.map(Schema.typeSchema),
      Array.appendAll(extraInboundSchemas)
    ) as Array.NonEmptyArray<AnyTaggedSchema>

    /**
     * Single-pass decode for inbound dispatch. `Schema.parseJson` parses
     * the wire string once; the surrounding `Schema.Union` discriminates
     * by `_tag` and produces the typed message in one shot. Tags outside
     * the union surface as `ParseError` and are logged-and-dropped.
     */
    const dispatchMessage: AnyTaggedSchema = Match.value(innerSchemas).pipe(
      Match.withReturnType<AnyTaggedSchema>(),
      Match.when(
        (arr): arr is [AnyTaggedSchema] => arr.length == 1,
        ([first]) => first
      ),
      Match.orElse(([first, ...rest]) => Schema.Union(first, ...rest))
    )

    const decodeMessage = Schema.decode(Schema.parseJson(dispatchMessage))

    /**
     * Decode one raw inbound message and route to its handler, or
     * log-and-drop it when no handler is registered for its tag. Schema
     * acceptance guarantees `_tag: string`; re-narrow at this single
     * boundary.
     */
    const dispatch = (raw: string): Effect.Effect<void, ParseResult.ParseError> =>
      Effect.gen(function* () {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const decoded = (yield* decodeMessage(raw)) as MessageHandler.DecodedMessage
        yield* Option.match(yield* registry.lookup(decoded._tag), {
          onSome: (handler) => handler(decoded),
          onNone: () =>
            Effect.logWarning(
              `[effect-messaging] no handler for inbound tag "${decoded._tag}"; dropping`
            ),
        })
      })

    const inbox = yield* Queue.unbounded<string>()

    // Seed the inbox with whatever the adapter has already collected
    // (e.g. URL-param-encoded messages on the web side). Done before
    // the live source attaches and before the dispatch fiber starts, so
    // initial messages always reach the dispatcher first and FIFO
    // ordering is enforced by code rather than by author discipline.
    const initial = yield* adapter.drainInitial
    for (const raw of initial) {
      yield* Queue.offer(inbox, raw)
    }

    const enqueue = (raw: string): Effect.Effect<void> => offerQuietly(inbox, raw)

    if (adapter.attachBareSender !== undefined) {
      yield* adapter.attachBareSender(enqueue)
    }

    // Start the dispatch fiber last — by this point both the initial
    // drain has been offered and the live source is wired, so the
    // dispatcher consumes everything in arrival order.
    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(inbox, { shutdown: true }), (raw) =>
        dispatch(raw).pipe(
          Effect.catchAll((error) =>
            // `ParseResult.TreeFormatter` renders the full `error.issue`
            // tree, which `String(error)` would flatten to a single line.
            // Wrapping the formatted message in `Effect.logWarning` keeps
            // the schema-rejection detail visible in logs.
            Effect.logWarning(
              `[effect-messaging] failed to decode message: ${ParseResultMod.TreeFormatter.formatErrorSync(error)}`
            )
          ),
          // Handler defects don't take the dispatch fiber down.
          Effect.catchAllDefect((defect) =>
            Effect.logError(`[effect-messaging] dispatch defect; continues: ${String(defect)}`)
          )
        )
      )
    )

    return { enqueue }
  })

export { makeInboundDispatcher }
export type { AnyTaggedSchema, InboundDispatcher }
