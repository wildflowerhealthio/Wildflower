import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  DocumentReference,
  type FhirResourceWithId,
  MedicationRequest,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  LinkChoiceSet,
  SectionedList,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Schema, TestContext } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { formatRegistry } from './registry.ts'
import { resolveMentions, type ResolvedBatch } from './resolve-mentions.ts'
import type * as ReviewGroup from './review-group.ts'
import { keysWithoutPatientOf } from './unlinked-mentions.ts'

const SOURCE_PATIENT = 'https://source.example/patient-id'
const CUSTOMER = 'https://source.example/customer-id'

/** A `MedicationRequest` naming its subject by `subject`. */
const request = (id: string, subject: object): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(MedicationRequest.Schema))({
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject,
  })

/** The HAR format's own source file: a `DocumentReference` with no subject. */
const HAR_SOURCE_FILE = Schema.decodeUnknownSync(withMandatoryId(DocumentReference.Schema))({
  resourceType: 'DocumentReference',
  id: 'src-1',
  status: 'current',
  category: [{ coding: [formatRegistry.har.sourceFileFormat.coding] }],
  content: [{ attachment: { contentType: 'application/json' } }],
})

const PATIENT = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
  resourceType: 'Patient',
  id: 'p-1',
  identifier: [{ system: SOURCE_PATIENT, value: 'p-1' }],
})

/**
 * A HAR batch of `resources`, keyed `k-<index>`, resolved with every
 * referent on its default, on a `TestClock` standing at the epoch.
 */
const resolvedHarBatchOf = (resources: readonly FhirResourceWithId[]): ResolvedBatch => {
  const har: ReviewGroup.Type = {
    sectionedList: SectionedList.make([
      {
        title: 'Resources',
        rows: resources.map((resource, index) => ({
          reviewKey: `k-${index}`,
          title: `${resource.resourceType}/${resource.id}`,
          isImplied: false,
          resource,
        })),
      },
    ]),
    notes: [],
    unreadableFiles: [],
    files: [{ id: '0:har', fileName: 'har', bytes: new Uint8Array([1]) }],
  }
  return Effect.runSync(
    resolveMentions({ groups: { har }, unrecognizedFiles: [] }, LinkChoiceSet.empty).pipe(
      Effect.provide(TestContext.TestContext)
    )
  )
}

/** The HAR group of `batch`, failing the test when it has none. */
const harGroupOf = (batch: ResolvedBatch): ReviewGroup.Type => {
  const group = batch.groups.har
  if (group === undefined) throw expect.fail('expected a HAR group')
  return group
}

describe('keysWithoutPatientOf', () => {
  const batch = resolvedHarBatchOf([
    HAR_SOURCE_FILE,
    PATIENT,
    request('rx-patient', { reference: 'Patient/p-1' }),
    request('rx-display', { display: 'Someone' }),
    request('rx-account', { type: 'Patient', identifier: { system: CUSTOMER, value: 'c-9' } }),
  ])

  it('names the rows that name no patient or an unlinked one, the source file never', () => {
    expect([
      ...keysWithoutPatientOf(batch.plan, 'har', harGroupOf(batch), StagedImport.initial()),
    ]).toEqual(['k-3', 'k-4'])
  })

  it('asks a row as edited, so an edit that gives it a patient takes it out', () => {
    const selection = StagedImport.edit(
      StagedImport.initial(),
      'k-3',
      request('rx-display', { reference: 'Patient/p-1' })
    )

    expect([...keysWithoutPatientOf(batch.plan, 'har', harGroupOf(batch), selection)]).toEqual([
      'k-4',
    ])
  })
})
