import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect } from 'effect'

import type * as ChatPatient from '../../chat-patient.ts'
import type * as WriteProposal from '../../write-proposal.ts'
import * as PatientPin from '../patient-pin.ts'
import type * as RecordAccess from '../record-access.ts'
import { type Call, offeredTypesOf } from './chat-tools.ts'
import type * as ChatTools from './chat-tools.ts'
import { decodeInput, offeredTypeOf, refuse, type ToolCallRefused } from './refusal.ts'
import { CREATE_RECORD } from './tool-names.ts'
import { pinnedForCreate, refuseIfAboutAnotherPatient } from './write-patient-pin.ts'
import { resourceInputSchemaOf, WRITE_DECISION_NOTE, WriteRecordInput } from './write-record.ts'

/**
 * `create_record`: propose a new record, which the person approves or
 * declines before it is created.
 *
 * @packageDocumentation
 */

/**
 * `create_record`'s definition. Not `strict`: a resource is an open object,
 * which strict tool schemas can't express (every object there must forbid
 * properties it doesn't list); the input is decoded before it runs.
 */
const createRecordDefinition = (
  patient: ChatPatient.Type,
  creatableTypes: readonly ResourceType.Type[]
): BetaTool => ({
  name: CREATE_RECORD,
  description:
    'Propose a new record for the FHIR server, as a whole FHIR R4 resource in JSON, without an id: the server assigns one.' +
    WRITE_DECISION_NOTE +
    (patient.kind === 'patient'
      ? " This chat is about one patient: the tool sets the record's subject or patient reference to them, so a record about a patient needs one of those elements, and a record about another patient is refused."
      : ''),
  input_schema: {
    type: 'object',
    properties: {
      resource: resourceInputSchemaOf(creatableTypes, 'The new record, as FHIR R4 JSON.'),
    },
    required: ['resource'],
    additionalProperties: false,
  },
})

/**
 * The types `create_record` offers a chat about `patient`: those
 * `creatable` covers that the chat can keep to them, but in a chat about one
 * patient not `Patient`, since a new patient is not that patient, nor a type
 * the tool can't point at them ({@link PatientPin.canBePointedAtPatient}).
 */
const creatableTypesOf = (
  creatable: RecordAccess.ResourceTypes,
  patient: ChatPatient.Type
): readonly ResourceType.Type[] =>
  offeredTypesOf(creatable, patient).filter(
    (resourceType) =>
      patient.kind === 'all-patients' ||
      (resourceType !== 'Patient' && PatientPin.canBePointedAtPatient(resourceType))
  )

/** The proposal for the `create_record` call `call`, or why it is refused. */
const proposeCreate = (
  tools: ChatTools.Type,
  call: Call
): Effect.Effect<WriteProposal.Type, ToolCallRefused> =>
  Effect.gen(function* () {
    const { resource } = yield* decodeInput(WriteRecordInput, call.input)
    if (tools.patient.kind === 'patient' && resource.resourceType === 'Patient') {
      return yield* refuse(
        "This chat is about one patient, so it can't create a Patient: a new patient isn't this one."
      )
    }
    const createdType = yield* offeredTypeOf(tools.creatableTypes, resource.resourceType)
    if (Object.hasOwn(resource, 'id')) {
      return yield* refuse('Leave out the id: the server assigns one to a new record.')
    }
    yield* refuseIfAboutAnotherPatient(
      tools,
      resource,
      "This record is about another patient, so it can't be created: this chat is about one patient."
    )
    const pinned = yield* pinnedForCreate(tools.patient, createdType, {
      ...resource,
      resourceType: createdType,
    })
    return { kind: 'create', callId: call.id, resource: pinned }
  })

export { creatableTypesOf, createRecordDefinition, proposeCreate }
