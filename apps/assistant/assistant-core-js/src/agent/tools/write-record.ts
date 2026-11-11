import type { ResourceWrite } from '@wildflowerhealthio/fhir-r4/clients'
import { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Option, Schema } from 'effect'

import { enumOf } from './json-schema.ts'

/**
 * What `create_record` and `update_record` share: their input, the JSON
 * Schema of the resource they take, what their descriptions say of the
 * person's decision, and their result.
 *
 * @packageDocumentation
 */

/** A resource as the agent writes it: FHIR JSON naming its `resourceType`. */
const ResourceInput = Schema.Struct(
  { resourceType: Schema.String },
  Schema.Record({ key: Schema.String, value: Schema.Unknown })
)

/** `create_record`'s and `update_record`'s input: the whole resource to write. */
const WriteRecordInput = Schema.Struct({ resource: ResourceInput })

/**
 * `create_record`'s and `update_record`'s result, as the JSON the agent
 * reads: the record as the server stored it, its type, the id it is stored
 * under, and its `versionId` when the server keeps versions.
 */
const WriteRecordResult = Schema.parseJson(
  Schema.Struct({
    resourceType: ResourceType.Schema,
    id: Schema.String,
    versionId: Schema.optionalWith(Schema.String, { exact: true }),
    record: Schema.Unknown,
  })
)

/** The JSON Schema of a write tool's `resource`: an object whose `resourceType` is one of `types`. */
const resourceInputSchemaOf = (
  types: readonly ResourceType.Type[],
  description: string
): Record<string, unknown> => ({
  type: 'object',
  description,
  properties: { resourceType: enumOf(types, "The record's FHIR resource type.") },
  required: ['resourceType'],
})

/** What every write tool's description says of the person's decision. */
const WRITE_DECISION_NOTE =
  ' Nothing is saved until the person approves it: the result is the stored record, or why it was not saved. "The user declined this change." means they said no, followed by their reason when they gave one.'

/** The result JSON for `written`, the record a write of `resourceType` stored. */
const writeRecordResultOf = (
  resourceType: ResourceType.Type,
  written: ResourceWrite.Written
): string =>
  Schema.encodeSync(WriteRecordResult)({
    resourceType,
    id: written.id,
    ...Option.match(written.versionId, {
      onNone: () => ({}),
      onSome: (versionId) => ({ versionId }),
    }),
    record: written.record,
  })

export {
  resourceInputSchemaOf,
  WRITE_DECISION_NOTE,
  WriteRecordInput,
  WriteRecordResult,
  writeRecordResultOf,
}
