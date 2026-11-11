import type { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Data, Effect, Option, Schema } from 'effect'

import type { Call } from './chat-tools.ts'

/**
 * A call the tools refuse, and the checks every tool refuses through: an
 * input that doesn't decode, a type the tool doesn't offer, a tool the chat
 * doesn't have.
 *
 * @packageDocumentation
 */

/** A call the tool would not make, and why, in words for the agent. */
class ToolCallRefused extends Data.TaggedClass('ToolCallRefused')<{ readonly reason: string }> {}

const refuse = (reason: string): Effect.Effect<never, ToolCallRefused> =>
  Effect.fail(new ToolCallRefused({ reason }))

/** `input` decoded through `schema`, refusing anything else, extra properties included. */
const decodeInput = <A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown
): Effect.Effect<A, ToolCallRefused> =>
  Schema.decodeUnknown(schema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () => new ToolCallRefused({ reason: "The input doesn't match the tool's input schema." })
    )
  )

/** `resourceType` as one of `offered`, or refused naming the tool's types. */
const offeredTypeOf = (
  offered: readonly ResourceType.Type[],
  resourceType: string
): Effect.Effect<ResourceType.Type, ToolCallRefused> =>
  Array.findFirst(offered, (each) => each === resourceType).pipe(
    Option.match({
      onNone: () => refuse(`${resourceType} isn't one of the record types this tool can reach.`),
      onSome: Effect.succeed,
    })
  )

/** Refuse `call` as naming no tool the chat has. */
const refuseUnknownTool = (call: Call): Effect.Effect<never, ToolCallRefused> =>
  refuse(`There is no tool called ${call.name}.`)

export { decodeInput, offeredTypeOf, refuse, refuseUnknownTool, ToolCallRefused }
