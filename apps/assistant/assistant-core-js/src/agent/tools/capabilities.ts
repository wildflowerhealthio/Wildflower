import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, Option, Schema } from 'effect'

import { type FhirReadFailed, FhirRecords } from '../../fhir-records.ts'
import type * as ChatTools from './chat-tools.ts'
import { decodeInput, refuse, type ToolCallRefused } from './refusal.ts'
import { CAPABILITIES } from './tool-names.ts'

/**
 * `capabilities`: what the server says it can search on, for the types the
 * chat can search.
 *
 * @packageDocumentation
 */

/** `capabilities`' input: nothing. */
const CapabilitiesInput = Schema.Struct({})

/**
 * `capabilities`' result, as the JSON the agent reads: for each type the
 * chat can search that the server's `CapabilityStatement` lists, the search
 * parameters it lists for it.
 */
const CapabilitiesResult = Schema.parseJson(
  Schema.Struct({
    resourceTypes: Schema.Array(
      Schema.Struct({ type: ResourceType.Schema, searchParams: Schema.Array(Schema.String) })
    ),
  })
)

const CAPABILITIES_DEFINITION: BetaTool = {
  name: CAPABILITIES,
  description:
    "Find out what the FHIR server can search on: for each record type you can search, the search parameters the server's CapabilityStatement lists.",
  strict: true,
  input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
}

/** A `CapabilityStatement`, as far as `capabilities` reads it. */
const CapabilityStatementSearches = Schema.Struct({
  resourceType: Schema.Literal('CapabilityStatement'),
  rest: Schema.optional(
    Schema.Array(
      Schema.Struct({
        resource: Schema.optional(
          Schema.Array(
            Schema.Struct({
              type: Schema.String,
              searchParam: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
            })
          )
        ),
      })
    )
  ),
})

const capabilities = (
  tools: ChatTools.Type,
  input: unknown
): Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    yield* decodeInput(CapabilitiesInput, input)
    const records = yield* FhirRecords
    const statement = yield* records.read('metadata').pipe(
      Effect.flatMap(Schema.decodeUnknown(CapabilityStatementSearches)),
      Effect.catchTag('ParseError', () =>
        refuse("The server's answer wasn't a CapabilityStatement.")
      )
    )
    const resourceTypes = (statement.rest ?? [])
      .flatMap(({ resource }) => resource ?? [])
      .flatMap(({ type, searchParam }) =>
        Array.findFirst(tools.searchableTypes, (searchableType) => searchableType === type).pipe(
          Option.map((searchableType) => ({
            type: searchableType,
            searchParams: (searchParam ?? []).map(({ name }) => name),
          })),
          Option.toArray
        )
      )
    return Schema.encodeSync(CapabilitiesResult)({ resourceTypes })
  })

export { capabilities, CAPABILITIES_DEFINITION, CapabilitiesInput, CapabilitiesResult }
