import { Array, Effect, HashMap, type Option, pipe, Record, Ref } from 'effect'
import type * as Bridge from '../bridge.ts'
import type * as MessageHandler from '../message-handler.ts'
import { assertNoDuplicateTags } from './assert-no-duplicate-tags.ts'
import { READY_TAG } from './handshake-message.ts'

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
   * data). Throws (as a defect) on a duplicate-tag wiring error, leaving
   * the prior map in place — the `Ref.set` never runs.
   */
  readonly register: (handlers: Bridge.HandlersByBridge<Bridges, InDir>) => Effect.Effect<void>
}

/**
 * Build the inbound handler registry for a fixed bridges tuple.
 *
 * @remarks
 * `readyTagHandler` is injected (not owned here) so the registry stays
 * ignorant of handshake semantics — it only knows it must append one
 * extra control handler that survives every replace. **Temporary:** the
 * `__Ready` append goes away under Leap C (Phase 3), when `__Ready`
 * becomes an ordinary registered handler.
 */
const makeHandlerRegistry = <
  const Bridges extends ReadonlyArray<Bridge.AnyBridge>,
  const InDir extends Bridge.Direction,
>(config: {
  readonly bridges: Bridges
  readonly initialHandlers: Bridge.HandlersByBridge<Bridges, InDir>
  readonly readyTagHandler: MessageHandler.Handler
}): Effect.Effect<HandlerRegistry<Bridges, InDir>> =>
  Effect.gen(function* () {
    const { bridges, readyTagHandler } = config

    /**
     * Pure tag→handler map builder. Folds the `Bridges` × handler-records
     * parallel tuples into a flat `HashMap<tag, Handler>`, always
     * appending the `__Ready` handler so the handshake survives every
     * replace. Throws synchronously on duplicate inbound tags across
     * bridges — a wiring error.
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
            return Record.toEntries(handlers as MessageHandler.AnyHandlers)
          }
        ),
        Array.flatten,
        Array.filter((entry): entry is [string, MessageHandler.Handler] => entry[1] !== undefined),
        Array.append([READY_TAG, readyTagHandler] as [string, MessageHandler.Handler])
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
    // duplicate-tag throw surfaces as a defect on the returned Effect (not
    // at call construction), and the `Ref.set` never runs, so the prior
    // map stays put.
    const register = (handlers: Bridge.HandlersByBridge<Bridges, InDir>): Effect.Effect<void> =>
      Effect.suspend(() => Ref.set(handlersRef, buildHandlerByTag(handlers)))

    return { lookup, register }
  })

export { makeHandlerRegistry }
export type { HandlerRegistry }
