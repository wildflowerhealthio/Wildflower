import type { ResourceWrite } from '@wildflowerhealthio/fhir-r4/clients'
import type { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, Option, Schema } from 'effect'

import * as ChatPatient from '../../chat-patient.ts'
import * as PatientPin from '../patient-pin.ts'
import type * as ChatTools from './chat-tools.ts'
import { refuse, type ToolCallRefused } from './refusal.ts'

/**
 * How a write in a chat about one patient is kept to them: a record about
 * another patient is refused, and a new record about a patient is pointed
 * at the chat's.
 *
 * @packageDocumentation
 */

/** A record as far as its contained resources are read. */
const RecordWithContained = Schema.Struct({ contained: Schema.Array(Schema.Unknown) })

const decodeRecordWithContained = Schema.decodeUnknownOption(RecordWithContained)

/** `record` and the resources it contains, each of which a write stores with it. */
const recordAndContainedOf = (record: unknown): readonly unknown[] => [
  record,
  ...decodeRecordWithContained(record).pipe(
    Option.map(({ contained }) => contained),
    Option.getOrElse((): readonly unknown[] => [])
  ),
]

/**
 * Refuse `record`, a record to write or the record a write changes, if the
 * chat is about one patient and it, or a resource it contains, is about
 * another.
 */
const refuseIfAboutAnotherPatient = (
  tools: ChatTools.Type,
  record: unknown,
  reason: string
): Effect.Effect<void, ToolCallRefused> =>
  Option.match(ChatPatient.patientIdIfOne(tools.patient), {
    onNone: () => Effect.void,
    onSome: (patientId) =>
      recordAndContainedOf(record).some((each) => PatientPin.isAboutAnotherPatient(each, patientId))
        ? refuse(reason)
        : Effect.void,
  })

/** The elements a record about a patient names them by. */
const PATIENT_REFERENCE_ELEMENTS = ['subject', 'patient'] as const

/**
 * The reference to `Patient/<patientId>` a pinned element is replaced with,
 * whatever the agent put there: an `identifier`, `display` or `type` beside
 * it could name someone else.
 */
const referenceToPatient = (patientId: string): { readonly reference: string } => ({
  reference: `Patient/${patientId}`,
})

/**
 * `resource`, of `resourceType`, as a chat about `patient` creates it: in a
 * chat about one patient, a record about a patient has its `subject` and
 * `patient` elements replaced with a reference to them, and is refused when
 * it has neither; any other record is created as given.
 */
const pinnedForCreate = (
  patient: ChatPatient.Type,
  resourceType: ResourceType.Type,
  resource: ResourceWrite.ResourceJson
): Effect.Effect<ResourceWrite.ResourceJson, ToolCallRefused> =>
  Option.match(ChatPatient.patientIdIfOne(patient), {
    onNone: () => Effect.succeed(resource),
    onSome: (patientId) =>
      PatientPin.of(resourceType).pipe(
        Option.filter((pin) => pin.kind === 'by-reference'),
        Option.match({
          onNone: () => Effect.succeed(resource),
          onSome: () => {
            const elements = PATIENT_REFERENCE_ELEMENTS.filter((name) =>
              Object.hasOwn(resource, name)
            )
            return Array.isNonEmptyReadonlyArray(elements)
              ? Effect.succeed({
                  ...resource,
                  ...Object.fromEntries(
                    elements.map((name) => [name, referenceToPatient(patientId)])
                  ),
                })
              : refuse(
                  `A ${resourceType} is about a patient: add its subject or patient reference (whichever the type has), and the tool points it at Patient/${patientId}, the patient this chat is about.`
                )
          },
        })
      ),
  })

export { pinnedForCreate, refuseIfAboutAnotherPatient }
