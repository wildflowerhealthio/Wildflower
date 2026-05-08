import type { Effect, Schema } from 'effect'
import type * as Message from './message.ts'

/**
 * Receiver-side type machinery. A `MessageHandler.HandlersFor<R>` is
 * the per-tag Effect-callback record `Bridge.make`'s `ReceiverLayer`
 * factory consumes; `MessageHandler.TagId<...>` is the string-literal
 * Identifier each `HandlerTag` is keyed by at runtime.
 *
 * Module is type-only. Re-exported as the `MessageHandler` namespace
 * from `effect-messaging-core`'s barrel.
 */

/**
 * Per-tag handler record. Each callback receives the decoded message
 * for its tag and returns an Effect — context (logger, services) flows
 * through naturally without `Effect.runSync` boundaries. Sync side
 * effects wrap with `Effect.sync(() => ...)`; trivial no-ops can
 * return `Effect.void`.
 */
type HandlersFor<R extends Message.SchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never>
    ? (message: A) => Effect.Effect<void>
    : never
}

/**
 * String-literal Identifier for a bridge half's `Context.Tag`. Two
 * `Bridge.make({name: 'X', ...})` calls produce *type-equivalent*
 * `HandlerTag`s (same Identifier + Service shapes) but
 * *runtime-distinct* tag instances (each `Context.GenericTag(...)`
 * call mints a fresh instance). This is intentional: TypeScript can't
 * mint fresh nominal types from value calls, so the type system can't
 * catch accidental name collisions; the runtime, however, never
 * confuses two distinct bridges. Same trade-off `Context.Tag` makes
 * elsewhere in this repo.
 */
type TagId<Name extends string, Side extends 'Host' | 'Web'> = `${Name}.${Side}.HandlerTag`

export type { HandlersFor, TagId }
