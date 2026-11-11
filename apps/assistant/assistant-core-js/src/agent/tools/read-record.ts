import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { IdSchema } from '@wildflowerhealthio/fhir-r4/data-types'
import type { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Option, Schema } from 'effect'

import * as ChatPatient from '../../chat-patient.ts'
import { type FhirReadFailed, FhirRecords } from '../../fhir-records.ts'
import * as PatientPin from '../patient-pin.ts'
import type * as ChatTools from './chat-tools.ts'
import { enumOf } from './json-schema.ts'
import { decodeInput, offeredTypeOf, refuse, ToolCallRefused } from './refusal.ts'
import { withinResultLimit } from './result-limit.ts'
import { READ_RECORD } from './tool-names.ts'

/**
 * `read_record`: one record by type and id, refused when it is about
 * another patient in a chat about one.
 *
 * @packageDocumentation
 */

/** `read_record`'s input. */
const ReadRecordInput = Schema.Struct({ resourceType: Schema.String, id: Schema.String })

/** `read_record`'s result, as the JSON the agent reads: the record as the server sent it. */
const ReadRecordResult = Schema.parseJson()

const readRecordDefinition = (
  patient: ChatPatient.Type,
  readableTypes: readonly ResourceType.Type[]
): BetaTool => ({
  name: READ_RECORD,
  description:
    'Read one record from the FHIR server by its type and id, such as the Practitioner a reference like "Practitioner/123" points at. The result is the record as JSON.' +
    (patient.kind === 'patient'
      ? " This chat is about one patient: a record about another patient isn't returned."
      : ''),
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      resourceType: enumOf(readableTypes, "The record's FHIR resource type."),
      id: { type: 'string', description: "The record's id." },
    },
    required: ['resourceType', 'id'],
    additionalProperties: false,
  },
})

const readRecord = (
  tools: ChatTools.Type,
  input: unknown
): Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    const { resourceType, id } = yield* decodeInput(ReadRecordInput, input)
    const readType = yield* offeredTypeOf(tools.readableTypes, resourceType)
    const recordId = yield* Schema.decodeUnknown(IdSchema)(id).pipe(
      Effect.mapError(() => new ToolCallRefused({ reason: `"${id}" isn't a FHIR id.` }))
    )
    const records = yield* FhirRecords
    const record = yield* records.read(`${readType}/${recordId}`)
    yield* Option.match(ChatPatient.patientIdIfOne(tools.patient), {
      onNone: () => Effect.void,
      onSome: (patientId) =>
        PatientPin.isAboutAnotherPatient(record, patientId)
          ? refuse(
              "This record is about another patient, so it isn't shown: this chat is about one patient."
            )
          : Effect.void,
    })
    return yield* withinResultLimit(Schema.encodeSync(ReadRecordResult)(record))
  })

export { readRecord, readRecordDefinition, ReadRecordInput, ReadRecordResult }
