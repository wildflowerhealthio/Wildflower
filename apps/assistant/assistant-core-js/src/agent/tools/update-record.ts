import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { diffJson, withoutServerManagedMeta } from '@wildflowerhealthio/fhir-r4/clients'
import { IdSchema } from '@wildflowerhealthio/fhir-r4/data-types'
import type { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Option, Predicate, Record as EffectRecord, Schema } from 'effect'

import type * as ChatPatient from '../../chat-patient.ts'
import { type FhirReadFailed, FhirRecords } from '../../fhir-records.ts'
import type * as WriteProposal from '../../write-proposal.ts'
import type { Call } from './chat-tools.ts'
import type * as ChatTools from './chat-tools.ts'
import { versionIdOf } from './record-versions.ts'
import { decodeInput, offeredTypeOf, refuse, ToolCallRefused } from './refusal.ts'
import { UPDATE_RECORD } from './tool-names.ts'
import { STALE_RECORD_TEXT } from './tool-result.ts'
import { refuseIfAboutAnotherPatient } from './write-patient-pin.ts'
import { resourceInputSchemaOf, WRITE_DECISION_NOTE, WriteRecordInput } from './write-record.ts'

/**
 * `update_record`: propose a change to a record read in this chat, shown
 * field by field, which the person approves or declines before it is saved
 * against the version that was read.
 *
 * @packageDocumentation
 */

/** `update_record`'s definition; not `strict`, as `create_record`'s isn't. */
const updateRecordDefinition = (
  patient: ChatPatient.Type,
  updatableTypes: readonly ResourceType.Type[]
): BetaTool => ({
  name: UPDATE_RECORD,
  description:
    'Propose a change to a record you have read in this chat (with read_record, search_records or next_page): give the whole record as it should be, as FHIR R4 JSON with its id, not only the fields that change. The person sees each field that changes.' +
    WRITE_DECISION_NOTE +
    " It is saved only if the record is still the version you read; if it changed, read it again and propose the change afresh. Records are never deleted: to retract one entered by mistake, set its status to entered-in-error (or the type's equivalent)." +
    (patient.kind === 'patient'
      ? ' This chat is about one patient: only their records can be changed.'
      : ''),
  input_schema: {
    type: 'object',
    properties: {
      resource: resourceInputSchemaOf(
        updatableTypes,
        'The whole record as it should be, with its id.'
      ),
    },
    required: ['resource'],
    additionalProperties: false,
  },
})

/**
 * `record` as an update's diff reads it: its server-managed `meta` fields
 * dropped, and `meta` itself when nothing else is in it, so a change given
 * without `meta` doesn't read as removing one.
 */
const contentOf = (record: unknown): unknown => {
  const content = withoutServerManagedMeta(record)
  return Predicate.isRecord(content) &&
    Predicate.isRecord(content['meta']) &&
    EffectRecord.isEmptyRecord(content['meta'])
    ? EffectRecord.remove(content, 'meta')
    : content
}

/**
 * The proposal for the `update_record` call `call`, or why it is refused:
 * the record must have been read in this chat (`versionsRead`), and is read
 * again now, so the change is shown against the record as it is and
 * proposed only while that is still the version the agent read.
 */
const proposeUpdate = (
  tools: ChatTools.Type,
  call: Call,
  versionsRead: ReadonlyMap<string, string>
): Effect.Effect<WriteProposal.Type, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    const { resource } = yield* decodeInput(WriteRecordInput, call.input)
    const updatedType = yield* offeredTypeOf(tools.updatableTypes, resource.resourceType)
    const recordId = yield* Schema.decodeUnknown(IdSchema)(resource['id']).pipe(
      Effect.mapError(
        () => new ToolCallRefused({ reason: 'Give the id of the record to change, a FHIR id.' })
      )
    )
    const reference = `${updatedType}/${recordId}`
    const versionRead = yield* Option.fromNullable(versionsRead.get(reference)).pipe(
      Option.match({
        onNone: () =>
          refuse(
            `${reference} hasn't been read in this chat, so the version to change isn't known. Read it with read_record first.`
          ),
        onSome: Effect.succeed,
      })
    )
    const proposed = { ...resource, resourceType: updatedType, id: recordId }
    yield* refuseIfAboutAnotherPatient(
      tools,
      proposed,
      "This change would make the record about another patient, so it isn't proposed: this chat is about one patient."
    )
    const records = yield* FhirRecords
    const current = yield* records.read(reference)
    yield* refuseIfAboutAnotherPatient(
      tools,
      current,
      "This record is about another patient, so it can't be changed: this chat is about one patient."
    )
    if (!Option.contains(versionIdOf(current), versionRead)) {
      return yield* refuse(STALE_RECORD_TEXT)
    }
    const fields = diffJson(contentOf(current), contentOf(proposed))
    if (fields.length === 0) {
      return yield* refuse('The record already says this, so there is nothing to change.')
    }
    return { kind: 'update', callId: call.id, resource: proposed, versionId: versionRead, fields }
  })

export { proposeUpdate, updateRecordDefinition }
