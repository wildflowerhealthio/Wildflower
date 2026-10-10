import { DateTime, Effect } from 'effect'
import * as fc from 'fast-check'
import type { FhirResource, MedicationDispense, Patient } from 'fhir-r4/resources'
import { defaultHarSettings, harImporter } from 'har-importer-core'
import type { PickedFile } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import {
  dinOf,
  displayNameOf,
  dosageTextOf,
  medicationRequestsToDoseRegimens,
  repeatsAllowedOf,
  repeatsAvailableOf,
  type MedicationRequestWithId,
} from 'medication-core/fhir'
import { ShoppersIdentifierSystem } from 'shoppers-drugmart-source'
import { asOfArbitrary, type ExpectedPrescription } from 'synthetic-data-fundamentals/test-helpers'
import { describe, expect, test } from 'vite-plus/test'

import { shoppersPatientReferenceOf } from './shoppers-account.ts'
import * as ShoppersHar from './shoppers-har.ts'
import { type ShoppersCase, shoppersCaseArbitrary } from './test-helpers.ts'

/**
 * Generated family accounts' Shoppers HARs through the real HAR importer
 * (`har-importer-core`'s `harImporter.decode`, which recognizes the traffic
 * through `shoppers-drugmart-source` and synthesizes R4 resources from the
 * portal's JSON), then read the way the medication views read them
 * (`medication-core`).
 *
 * @remarks
 * Every expectation — the Patients, each request's name, DIN, sig, fills left,
 * quantity, supply, status, prescriber and prior-prescription link, every
 * fill's day, DIN and subject, and each dose regimen — is
 * `storyCaseArbitrary`'s own reckoning from the generated inputs, or the
 * portal's rules applied to it here, not the payload builders' code.
 */

const RUNS = numRunsFor({ base: 15 })

/** Each property imports every generated HAR: generous, so a slow runner or a scaled-up run count fits. */
const ROUND_TRIP_TIMEOUT_MILLIS = 60_000

/** Days a prescription stays valid from the day it is written, as Ontario pharmacies apply. */
const VALID_DAYS = 365

/** What one import extracted, source file excluded, and the sections it came in. */
interface Imported {
  readonly notes: readonly string[]
  readonly unreadableFiles: readonly unknown[]
  /** One per response the import read. */
  readonly sections: readonly (readonly FhirResource[])[]
  readonly resources: readonly FhirResource[]
  readonly requests: readonly MedicationRequestWithId[]
  readonly dispenses: readonly MedicationDispense.Type[]
  /** The Patient per managed person, in portal order. */
  readonly personPatients: readonly Patient.Type[]
  /** The account holder's Patient, keyed by `pcid`, which links to every managed person's. */
  readonly accountPatients: readonly Patient.Type[]
}

const isDispense = (resource: FhirResource): resource is MedicationDispense.Type =>
  resource.resourceType === 'MedicationDispense'

/** `har` through `harImporter.decode`, as one picked file. */
const importHar = async (har: string): Promise<Imported> => {
  const picked: PickedFile.Type = {
    id: '0:shoppers.har',
    fileName: 'shoppers.har',
    bytes: new TextEncoder().encode(har),
  }
  const result = await Effect.runPromise(harImporter.decode([picked], defaultHarSettings))
  const sections = result.decoded.sections
    .filter((section) => section.title !== 'Source file')
    .map((section) => section.resources.map((entry) => entry.resource))
  const resources = sections.flat()
  const patients = resources.flatMap((resource) =>
    resource.resourceType === 'Patient' ? [resource] : []
  )
  return {
    notes: result.decoded.notes,
    unreadableFiles: result.unreadableFiles,
    sections,
    resources,
    requests: resources.flatMap((resource) =>
      resource.resourceType === 'MedicationRequest' && resource.id !== null
        ? [{ ...resource, id: resource.id }]
        : []
    ),
    dispenses: resources.filter(isDispense),
    personPatients: patients.filter((patient) => patient.link.length === 0),
    accountPatients: patients.filter((patient) => patient.link.length > 0),
  }
}

/** One generated case: an as-of date and a family account. */
interface Run {
  readonly asOf: DateTime.Utc
  readonly shoppersCase: ShoppersCase
}

const runArbitrary: fc.Arbitrary<Run> = fc.record({
  asOf: asOfArbitrary,
  shoppersCase: shoppersCaseArbitrary,
})

/** `check` over each generated case's rendered, then imported, HAR. */
const assertRoundTrip = (check: (run: Run, imported: Imported) => void): Promise<void> =>
  fc.assert(
    fc.asyncProperty(runArbitrary, async (run) => {
      const har = await Effect.runPromise(ShoppersHar.render(run.asOf, run.shoppersCase.account))
      check(run, await importHar(har))
    }),
    { numRuns: RUNS }
  )

/** A generated prescription, with the index of the managed person it belongs to. */
interface PatientPrescription {
  readonly patientIndex: number
  readonly expected: ExpectedPrescription
  /** The prescriber's name as the pharmacy prints it. */
  readonly prescriber: string
  /** The product's brand name, which the portal names a prescription by. */
  readonly brandName: string
}

const prescriptionsOf = ({ patients }: ShoppersCase): readonly PatientPrescription[] =>
  patients.flatMap(({ story, expected }, patientIndex) =>
    expected.map((each) => {
      const prescription = story.prescriptions.find(({ key }) => key === each.key)
      return {
        patientIndex,
        expected: each,
        prescriber: prescription?.prescriber.display ?? '',
        brandName: prescription?.product.brandName ?? '',
      }
    })
  )

/** The calendar day `days` from the as-of day, worked out here. */
const isoDateOn = (asOf: DateTime.Utc, days: number): string =>
  DateTime.formatIsoDate(DateTime.add(DateTime.startOf(asOf, 'day'), { days }))

const isoDateOf = (instant: DateTime.Utc | null | undefined): string | null =>
  instant === null || instant === undefined ? null : DateTime.formatIsoDate(instant)

/**
 * The imported request for `each`: its patient's, dated (the importer's
 * `authoredOn` is the last fill) on its last fill day — which a generated
 * story never shares between two prescriptions.
 */
const requestFor = (
  asOf: DateTime.Utc,
  imported: Imported,
  { patientIndex, expected }: PatientPrescription
): MedicationRequestWithId | undefined => {
  const patient = imported.personPatients[patientIndex]
  return imported.requests.find(
    (request) =>
      request.subject.reference === `Patient/${patient?.id}` &&
      isoDateOf(request.authoredOn) === isoDateOn(asOf, expected.lastFillDay)
  )
}

const prescriptionNumberOf = (request: MedicationRequestWithId | undefined): string | null =>
  request?.identifier.find(
    (identifier) => identifier.system?.href === ShoppersIdentifierSystem.PrescriptionNumber
  )?.value ?? null

/** The dispenses that name `request` as their authorizing prescription. */
const dispensesOf = (
  imported: Imported,
  request: MedicationRequestWithId
): readonly MedicationDispense.Type[] =>
  imported.dispenses.filter((dispense) =>
    dispense.authorizingPrescription.some(
      (reference) => reference.reference === `MedicationRequest/${request.id}`
    )
  )

/**
 * Whether the portal files the prescription as archived: stopped, or
 * continued by a later prescription for the same drug.
 */
const isArchived = (expected: ExpectedPrescription): boolean =>
  expected.status === 'stopped' || expected.nextKey !== null

/** Whether the prescription's validity has run out by the as-of day. */
const isExpired = (expected: ExpectedPrescription): boolean => expected.writtenDay + VALID_DAYS <= 0

/**
 * The portal's machine status: unable to renew online once archived or
 * expired, else refillable while repeats remain, else renewable.
 */
const statusCodeOf = (expected: ExpectedPrescription): string => {
  if (isArchived(expected) || isExpired(expected)) return 'UNABLE_TO_RENEW_ONLINE'
  return expected.repeatsAvailable > 0 ? 'READY_FOR_REFILL' : 'READY_FOR_RENEW'
}

/** Whether the prescription is current: neither archived nor expired. */
const isCurrent = (expected: ExpectedPrescription): boolean =>
  !isArchived(expected) && !isExpired(expected)

/** The importer's status: `active` while current, else `stopped`. */
const requestStatusOf = (expected: ExpectedPrescription): 'active' | 'stopped' =>
  isCurrent(expected) ? 'active' : 'stopped'

/**
 * The days one fill lasts, as the import states it: the portal names a next
 * fill, one supply after the last, only for a current prescription with a
 * repeat left; any other states no supply.
 */
const supplyDaysOf = (expected: ExpectedPrescription): number | null =>
  isCurrent(expected) && expected.repeatsAvailable > 0 ? expected.supplyDays : null

describe(
  'ShoppersHar.render through the HAR importer',
  { timeout: ROUND_TRIP_TIMEOUT_MILLIS },
  () => {
    test('property: claims every XHR and no page', async () => {
      await assertRoundTrip((_run, imported) => {
        expect(imported.unreadableFiles).toEqual([])
        expect(imported.notes).toEqual([
          'Matched no importer: https://mypharmacy.shoppersdrugmart.ca/en/login',
          'Matched no importer: https://mypharmacy.shoppersdrugmart.ca/en/healthdashboard/',
          'Matched no importer: https://mypharmacy.shoppersdrugmart.ca/en/prescription-dashboard/?nav=featured-services/prescription-icon',
          'Matched no importer: https://mypharmacy.shoppersdrugmart.ca/en/prescription-history',
        ])
      })
    })

    test('property: yields a Patient per managed person, and the holder again as the account Patient linking them', async () => {
      await assertRoundTrip(({ shoppersCase }, imported) => {
        expect(
          imported.personPatients.map((patient) => [
            patient.name[0]?.given,
            patient.name[0]?.family,
          ])
        ).toEqual(
          shoppersCase.patients.map(({ story: { person } }) => [
            [person.givenName],
            person.familyName,
          ])
        )
        expect(imported.accountPatients).toHaveLength(1)
        const [accountPatient] = imported.accountPatients
        const holder = shoppersCase.account.patients[0].story.person
        expect(accountPatient?.name[0]).toMatchObject({
          given: [holder.givenName],
          family: holder.familyName,
        })
        expect(accountPatient?.telecom.map((telecom) => telecom.system)).toEqual(['email', 'phone'])
        expect(accountPatient?.link.map((link) => [link.type, link.other.reference])).toEqual(
          imported.personPatients.map((patient) => ['seealso', `Patient/${patient.id}`])
        )
      })
    })

    test("property: shoppersPatientReferenceOf spells the subject of every request of that person's", async () => {
      await assertRoundTrip(({ asOf, shoppersCase }, imported) => {
        for (const each of prescriptionsOf(shoppersCase)) {
          const managed = shoppersCase.account.patients[each.patientIndex]
          const expected = managed === undefined ? null : shoppersPatientReferenceOf(managed)
          expect(expected?.reference).toBe(
            `Patient/${imported.personPatients[each.patientIndex]?.id}`
          )
          expect(requestFor(asOf, imported, each)?.subject, each.expected.key).toEqual(expected)
        }
      })
    })

    test('property: yields a request per prescription, and a dispense per fill', async () => {
      await assertRoundTrip(({ shoppersCase }, imported) => {
        const prescriptions = prescriptionsOf(shoppersCase)
        const fillCount = prescriptions.reduce(
          (count, { expected }) => count + expected.fillDays.length,
          0
        )
        expect(imported.requests).toHaveLength(prescriptions.length)
        // The history feed lists every fill and the status feed each latest again; the
        // import merges the two copies of a latest fill into one.
        expect(imported.dispenses).toHaveLength(fillCount)
        expect(new Set(imported.dispenses.map((dispense) => dispense.id)).size).toBe(fillCount)
        expect(imported.resources).toHaveLength(
          shoppersCase.patients.length + 1 + prescriptions.length + fillCount
        )
      })
    })

    test('property: every request reads as its generated inputs say', async () => {
      await assertRoundTrip(({ asOf, shoppersCase }, imported) => {
        for (const each of prescriptionsOf(shoppersCase)) {
          const { expected } = each
          const request = requestFor(asOf, imported, each)
          expect(request, expected.key).toBeDefined()
          if (request === undefined) continue
          expect({
            name: displayNameOf(request),
            din: dinOf(request),
            sig: dosageTextOf(request),
            fillsLeft: repeatsAllowedOf(request),
            repeatsAvailable: repeatsAvailableOf(request),
            quantity: request.dispenseRequest?.quantity?.value,
            supplyDays: request.dispenseRequest?.expectedSupplyDuration?.value ?? null,
            status: request.status,
            statusCode: request.statusReason?.coding[0]?.code,
            requester: request.requester?.display,
          }).toEqual({
            name: each.brandName,
            din: expected.din,
            sig: expected.sig,
            // The portal states fills left, which the importer writes as the repeats allowed.
            fillsLeft: expected.repeatsAvailable,
            repeatsAvailable: null,
            quantity: expected.quantity,
            supplyDays: supplyDaysOf(expected),
            status: requestStatusOf(expected),
            statusCode: statusCodeOf(expected),
            requester: each.prescriber,
          })
        }
      })
    })

    test('property: every request links the prescription it continues by number', async () => {
      await assertRoundTrip(({ asOf, shoppersCase }, imported) => {
        const prescriptions = prescriptionsOf(shoppersCase)
        for (const each of prescriptions) {
          const previous = prescriptions.find(
            ({ expected }) => expected.key === each.expected.previousKey
          )
          const request = requestFor(asOf, imported, each)
          expect(request?.priorPrescription?.identifier?.value ?? null, each.expected.key).toBe(
            previous === undefined
              ? null
              : prescriptionNumberOf(requestFor(asOf, imported, previous))
          )
        }
      })
    })

    test('property: every fill is a completed dispense, with the DIN it dispensed', async () => {
      await assertRoundTrip(({ asOf, shoppersCase }, imported) => {
        for (const each of prescriptionsOf(shoppersCase)) {
          const { expected } = each
          const request = requestFor(asOf, imported, each)
          const dispenses = request === undefined ? [] : dispensesOf(imported, request)
          expect(
            dispenses
              .map((dispense) => [
                isoDateOf(dispense.whenHandedOver),
                dispense.medicationCodeableConcept?.coding[0]?.code,
              ])
              .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
            expected.key
          ).toEqual(expected.fillDays.map((day) => [isoDateOn(asOf, day), expected.din]))
          expect(
            new Set(dispenses.map((dispense) => `${dispense.status} ${dispense.quantity?.value}`))
          ).toEqual(new Set([`completed ${expected.quantity}`]))
        }
      })
    })

    test('property: every latest fill names the patient, and every earlier fill the account', async () => {
      await assertRoundTrip(({ asOf, shoppersCase }, imported) => {
        const accountReference = `Patient/${imported.accountPatients[0]?.id}`
        for (const each of prescriptionsOf(shoppersCase)) {
          const request = requestFor(asOf, imported, each)
          const lastFillDate = isoDateOn(asOf, each.expected.lastFillDay)
          expect(
            (request === undefined ? [] : dispensesOf(imported, request))
              .map(
                (dispense) => `${isoDateOf(dispense.whenHandedOver)} ${dispense.subject?.reference}`
              )
              .toSorted(),
            each.expected.key
          ).toEqual(
            each.expected.fillDays
              .map((day) => {
                const fillDate = isoDateOn(asOf, day)
                const subject =
                  fillDate === lastFillDate ? request?.subject.reference : accountReference
                return `${fillDate} ${subject}`
              })
              .toSorted()
          )
        }
      })
    })

    test('property: medication-core amortizes a daily dose over each prescription that states its supply', async () => {
      await assertRoundTrip(({ asOf, shoppersCase }, imported) => {
        const prescriptions = prescriptionsOf(shoppersCase)
        const batch = medicationRequestsToDoseRegimens(imported.requests)
        // A request with no supply states no dose either, so it plots nothing.
        const withSupply = prescriptions.filter(({ expected }) => supplyDaysOf(expected) !== null)
        expect({ undated: batch.undated, dropped: batch.dropped }).toEqual({
          undated: 0,
          dropped: prescriptions.length - withSupply.length,
        })
        for (const each of prescriptions) {
          const { expected } = each
          const request = requestFor(asOf, imported, each)
          const regimen = batch.regimens.find(({ requestId }) => requestId === request?.id)
          const supplyDays = supplyDaysOf(expected)
          expect(
            regimen === undefined
              ? null
              : {
                  amount: regimen.amount,
                  unit: regimen.unit,
                  per: regimen.per,
                  derivation: regimen.derivation,
                  status: regimen.status,
                  start: isoDateOf(regimen.start),
                  end: isoDateOf(regimen.end),
                },
            expected.key
          ).toEqual(
            supplyDays === null
              ? null
              : {
                  // One fill's tablets over the days it lasts; the portal states no strength.
                  amount: expected.quantity / supplyDays,
                  unit: null,
                  per: 'd',
                  derivation: 'amortized',
                  status: 'active',
                  // From the last fill to the next, which the import states as the fill window.
                  start: isoDateOn(asOf, expected.lastFillDay),
                  end: isoDateOn(asOf, expected.lastFillDay + supplyDays),
                }
          )
        }
      })
    })
  }
)
