import type { Effect, Schema } from 'effect'
import type * as Message from './message.ts'

/**
 * Per-tag handler record consumed by `Bridge.make`'s `ReceiverLayer`.
 * Each callback receives the decoded message for its tag and returns
 * an Effect — context (logger, services) flows through naturally.
 */
type HandlersFor<R extends Message.SchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never>
    ? (message: A) => Effect.Effect<void>
    : never
}

/**
 * String-literal Identifier for a bridge half's `Context.Tag`.
 *
 * @remarks
 * Two `Bridge.make({name: 'X', ...})` calls produce
 * type-equivalent `HandlerTag`s but runtime-distinct tag instances
 * (each `Context.GenericTag(...)` mints a fresh one). TypeScript can't
 * mint nominal types from value calls, so the type system can't catch
 * accidental name collisions; the runtime never confuses two bridges.
 */
type TagId<Name extends string, Side extends 'Host' | 'Web'> = `${Name}.${Side}.HandlerTag`

export type { HandlersFor, TagId }
