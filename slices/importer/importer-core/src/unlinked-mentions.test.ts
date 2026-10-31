import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  DocumentReference,
  type FhirResourceWithId,
  MedicationRequest,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  FormatDecode,
  LinkChoiceSet,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Schema, TestContext } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { formatRegistry } from './registry.ts'
import { resolveMentions, type ResolvedBatch } from './resolve-mentions.ts'
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
  const har: FormatDecode.Result<'har'> = {
    ...FormatDecode.emptyResult('har'),
    files: [{ id: '0:har', fileName: 'har', bytes: new Uint8Array([1]) }],
    decoded: {
      sections: [
        {
          title: 'Resources',
          resources: resources.map((resource, index) => ({
            key: `k-${index}`,
            title: `${resource.resourceType}/${resource.id}`,
            resource,
          })),
        },
      ],
      notes: [],
    },
  }
  return Effect.runSync(
    resolveMentions(
      {
        formats: {
          har,
          'lifelabs-pdf': FormatDecode.emptyResult('lifelabs-pdf'),
          dicom: FormatDecode.emptyResult('dicom'),
        },
        unrecognizedFiles: [],
      },
      LinkChoiceSet.empty
    ).pipe(Effect.provide(TestContext.TestContext))
  )
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
    expect([...keysWithoutPatientOf(batch, 'har', StagedImport.initial())]).toEqual(['k-3', 'k-4'])
  })

  it('asks a row as edited, so an edit that gives it a patient takes it out', () => {
    const selection = StagedImport.edit(
      StagedImport.initial(),
      'k-3',
      request('rx-display', { reference: 'Patient/p-1' })
    )

    expect([...keysWithoutPatientOf(batch, 'har', selection)]).toEqual(['k-4'])
  })
})
