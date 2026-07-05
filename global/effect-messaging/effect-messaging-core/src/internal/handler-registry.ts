import { Array, Effect, HashMap, type Option, pipe, Record, Ref } from 'effect'
import type * as Bridge from '../bridge.ts'
import type * as MessageHandler from '../message-handler.ts'
import { assertNoDuplicateTags, DuplicateTagError } from './assert-no-duplicate-tags.ts'

/**
 * The transport's inbound handler registry: a swappable flat tag→handler
 * map behind a {@link Ref}. {@link makeInboundDispatcher} reads it through
 * {@link HandlerRegistry.lookup} on every message; consumers swap the
 * whole set through {@link HandlerRegistry.register} (replace semantics).
 */
interface HandlerRegistry<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  InDir extends Bridge.Direction,
> {
  /**
   * Resolve the handler for a decoded message's `_tag`, or `None` when no
   * handler is registered for it. An Effect because the underlying `Ref`
   * may have been swapped by a concurrent {@link HandlerRegistry.register}.
   */
  readonly lookup: (tag: string) => Effect.Effect<Option.Option<MessageHandler.Handler>>
  /**
   * Replace the active per-bridge handler records with a new set, applied
   * atomically against the dispatcher's reads. Pure (records are plain
   * data). Fails with a {@link DuplicateTagError} on a duplicate-tag
   * wiring error, leaving the prior map in place — the `Ref.set` never
   * runs.
   */
  readonly register: (
    handlers: Bridge.HandlersByBridge<Bridges, InDir>
  ) => Effect.Effect<void, DuplicateTagError>
}

/**
 * Build the inbound handler registry for a fixed bridges tuple.
 *
 * @remarks
 * `controlHandlers` are extra reserved `[tag, handler]` entries merged on
 * top of the per-bridge records and re-applied on every replace. The
 * transport injects the `__Ready` handshake handler this way, so the
 * registry stays ignorant of handshake semantics — it just merges in
 * whatever control handlers it's handed.
 */
const makeHandlerRegistry = <
  const Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  const InDir extends Bridge.Direction,
>(config: {
  readonly bridges: Bridges
  readonly initialHandlers: Bridge.HandlersByBridge<Bridges, InDir>
  readonly controlHandlers: ReadonlyArray<readonly [string, MessageHandler.Handler]>
}): Effect.Effect<HandlerRegistry<Bridges, InDir>> =>
  Effect.gen(function* () {
    const { bridges, controlHandlers } = config

    /**
     * Pure tag→handler map builder. Folds the `Bridges` × handler-records
     * parallel tuples into a flat `HashMap<tag, Handler>`, then merges the
     * injected `controlHandlers` so they survive every replace. Throws
     * synchronously on duplicate inbound tags across bridges (or a control
     * tag that collides with a bridge tag) — a wiring error.
     */
    const buildHandlerByTag = (
      handlersByBridge: Bridge.HandlersByBridge<Bridges, InDir>
    ): HashMap.HashMap<string, MessageHandler.Handler> => {
      const tagHandlerPairs = pipe(
        Array.zipWith(
          bridges,
          handlersByBridge,
          (bridge, handlers): [string, MessageHandler.Handler | undefined][] => {
            if (bridge === undefined || handlers === undefined) {
              return []
            }
            // Each record's handlers accept their specific message type;
            // erase to the routing-site `Handler` shape (re-narrowed by
            // `_tag` at dispatch).
            return Record.toEntries(handlers satisfies MessageHandler.AnyHandlers)
          }
        ),
        Array.flatten,
        Array.filter((entry): entry is [string, MessageHandler.Handler] => entry[1] !== undefined),
        Array.appendAll(controlHandlers)
      )
      assertNoDuplicateTags(
        Array.map(tagHandlerPairs, ([tag]) => tag),
        'inbound'
      )

      return HashMap.fromIterable<string, MessageHandler.Handler>(tagHandlerPairs)
    }

    const handlersRef = yield* Ref.make(buildHandlerByTag(config.initialHandlers))

    const lookup = (tag: string): Effect.Effect<Option.Option<MessageHandler.Handler>> =>
      Effect.map(Ref.get(handlersRef), (byTag) => HashMap.get(byTag, tag))

    // `Effect.suspend` defers `buildHandlerByTag` to run time: a
    // duplicate-tag throw lands inside the suspend and is re-raised on
    // the typed failure channel, so callers can branch on
    // {@link DuplicateTagError} rather than letting the bug fall through
    // to the default unhandled-defect reporter. The `Ref.set` never runs
    // on failure, so the prior map stays put.
    const register = (
      handlers: Bridge.HandlersByBridge<Bridges, InDir>
    ): Effect.Effect<void, DuplicateTagError> =>
      Effect.suspend(() => {
        try {
          const next = buildHandlerByTag(handlers)
          return Ref.set(handlersRef, next)
        } catch (caught: unknown) {
          if (caught instanceof DuplicateTagError) return Effect.fail(caught)
          throw caught
        }
      })

    return { lookup, register }
  })

export { makeHandlerRegistry }
export type { HandlerRegistry }
