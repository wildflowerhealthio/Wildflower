import { type DateTime, Effect } from 'effect'
import * as fc from 'fast-check'
import type { ReferenceType } from 'fhir-r4/data-types'
import type { FhirResource, Patient } from 'fhir-r4/resources'
import { defaultHarSettings, harImporter } from 'har-importer-core'
import type { PickedFile } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  asOfArbitrary,
  labDrawsArbitrary,
  laboratoryArbitrary,
  requisitionArbitrary,
  rexallAccountArbitrary,
  shoppersCaseArbitrary,
  storyCaseArbitrary,
} from '../arbitraries.test-helpers.ts'
import * as RexallHar from '../rexall/rexall-har.ts'
import * as ShoppersHar from '../shoppers/shoppers-har.ts'
import type { SourcePatient } from '../source-patient.ts'
import type { Story } from '../story.ts'
import type { Laboratory } from './laboratory.ts'
import * as LifeLabs from './lifelabs.ts'

/**
 * Generated people's lab results filed on the Patient their pharmacy import
 * makes: a generated Rexall account's or Shoppers family account's HAR goes
 * through the real HAR importer, each person's labs through the LifeLabs
 * renderer with `sourcePatientOf` their pharmacy record, and every result's
 * subject must name the Patient the import produced for that person —
 * reference and source identifier as the import's own MedicationRequests
 * spell them, and never the Shoppers account (`pcid`) Patient.
 */

const RUNS = numRunsFor({ base: 10 })

/** A laboratory, and `count` people's draws on it. */
const labsArbitrary = (
  count: number
): fc.Arbitrary<{
  readonly laboratory: Laboratory
  readonly labDraws: readonly Story['labDraws'][]
}> =>
  laboratoryArbitrary.chain((laboratory) =>
    fc
      .tuple(...Array.from({ length: count }, () => labDrawsArbitrary(laboratory)))
      .map((labDraws) => ({ laboratory, labDraws }))
  )

/** Every resource `har` imports as, source file excluded. */
const importHar = async (har: string): Promise<readonly FhirResource[]> => {
  const picked: PickedFile.Type = {
    id: '0:pharmacy.har',
    fileName: 'pharmacy.har',
    bytes: new TextEncoder().encode(har),
  }
  const result = await Effect.runPromise(harImporter.decode([picked], defaultHarSettings))
  return result.decoded.sections
    .filter((section) => section.title !== 'Source file')
    .flatMap((section) => section.resources.map((entry) => entry.resource))
}

const patientsIn = (resources: readonly FhirResource[]): readonly Patient.Type[] =>
  resources.flatMap((resource) => (resource.resourceType === 'Patient' ? [resource] : []))

/** A reference as the fields that name its target: the literal and the source identifier. */
const spelled = (
  reference: ReferenceType | null | undefined
): { readonly reference: unknown; readonly system: unknown; readonly value: unknown } => ({
  reference: reference?.reference,
  system: reference?.identifier?.system?.href,
  value: reference?.identifier?.value,
})

/** The subjects of every result `story`'s labs render as, on `pharmacyPatient`. */
const labSubjectsOf = (
  asOf: DateTime.Utc,
  story: Story,
  laboratory: Laboratory,
  requisition: LifeLabs.LabRequisition,
  pharmacyPatient: SourcePatient
): readonly (ReferenceType | null)[] =>
  Effect.runSync(LifeLabs.render(asOf, story, laboratory, requisition, pharmacyPatient)).flatMap(
    (resource) =>
      resource.resourceType === 'Observation' || resource.resourceType === 'DiagnosticReport'
        ? [resource.subject]
        : []
  )

/** The subjects the import's MedicationRequests name, as the pharmacy wrote them. */
const requestSubjectsIn = (resources: readonly FhirResource[]): readonly (ReferenceType | null)[] =>
  resources.flatMap((resource) =>
    resource.resourceType === 'MedicationRequest' ? [resource.subject] : []
  )

describe('LifeLabs results on a Rexall Patient', () => {
  test('property: every result names the Patient the Rexall import makes of the profile', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          asOf: asOfArbitrary,
          storyCase: storyCaseArbitrary('person-1'),
          account: rexallAccountArbitrary,
          labs: labsArbitrary(1),
          requisition: requisitionArbitrary,
        }),
        async ({ asOf, storyCase, account, labs, requisition }) => {
          const { laboratory } = labs
          const story: Story = { ...storyCase.story, labDraws: labs.labDraws[0] ?? [] }
          const imported = await importHar(RexallHar.render(asOf, story, account))
          const [patient, ...others] = patientsIn(imported)
          expect(others).toEqual([])
          const [requestSubject] = requestSubjectsIn(imported)
          expect(spelled(requestSubject).reference).toBe(`Patient/${patient?.id}`)
          const subjects = labSubjectsOf(
            asOf,
            story,
            laboratory,
            requisition,
            RexallHar.sourcePatientOf(account)
          )
          expect(subjects.length).toBeGreaterThan(0)
          for (const subject of subjects) {
            expect(spelled(subject)).toEqual(spelled(requestSubject))
          }
        }
      ),
      { numRuns: RUNS }
    )
  }, 60_000)
})

describe('LifeLabs results on a Shoppers Patient', () => {
  test("property: every managed person's results name their own Patient, not the account's", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .record({
            asOf: asOfArbitrary,
            shoppersCase: shoppersCaseArbitrary,
            requisition: requisitionArbitrary,
          })
          .chain((run) =>
            labsArbitrary(run.shoppersCase.account.patients.length).map((labs) => ({
              ...run,
              labs,
            }))
          ),
        async ({ asOf, shoppersCase, labs, requisition }) => {
          const { laboratory } = labs
          const { account } = shoppersCase
          const imported = await importHar(ShoppersHar.render(asOf, account))
          const patients = patientsIn(imported)
          const accountPatientIds = patients
            .filter((patient) => patient.link.length > 0)
            .map((patient) => `Patient/${patient.id}`)
          const personPatientIds = patients
            .filter((patient) => patient.link.length === 0)
            .map((patient) => `Patient/${patient.id}`)
          expect(accountPatientIds).toHaveLength(1)
          const requestSubjects = requestSubjectsIn(imported)
          for (const [index, managed] of account.patients.entries()) {
            const story: Story = { ...managed.story, labDraws: labs.labDraws[index] ?? [] }
            const asImported = requestSubjects.find(
              (subject) => subject?.identifier?.value === managed.patientId
            )
            expect(personPatientIds).toContain(spelled(asImported).reference)
            const subjects = labSubjectsOf(
              asOf,
              story,
              laboratory,
              requisition,
              ShoppersHar.sourcePatientOf(managed)
            )
            expect(subjects.length).toBeGreaterThan(0)
            for (const subject of subjects) {
              expect(spelled(subject)).toEqual(spelled(asImported))
              expect(accountPatientIds).not.toContain(subject?.reference)
            }
          }
        }
      ),
      { numRuns: RUNS }
    )
  }, 60_000)
})
