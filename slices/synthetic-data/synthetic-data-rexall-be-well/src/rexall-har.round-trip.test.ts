import { DateTime, Effect, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { CanadianCodingSystem, CodeableConcept, Coding } from 'fhir-r4/data-types'
import type { FhirResource, MedicationDispense, Patient } from 'fhir-r4/resources'
import { defaultHarSettings, harImporter } from 'har-importer-core'
import type { PickedFile } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import {
  dinOf,
  displayNameOf,
  medicationRequestsToDoseRegimens,
  repeatsAllowedOf,
  repeatsAvailableOf,
  type MedicationRequestWithId,
} from 'medication-core/fhir'
import { REXALL_CAREBOOK_SYSTEM } from 'rexall-be-well-source'
import {
  ageOn,
  asOfArbitrary,
  type ExpectedPrescription,
  type StoryCase,
  storyCaseArbitrary,
} from 'synthetic-data-fundamentals/test-helpers'
import { describe, expect, test } from 'vite-plus/test'

import type { RexallAccount } from './rexall-account.ts'
import * as RexallHar from './rexall-har.ts'
import { rexallAccountArbitrary } from './test-helpers.ts'

/**
 * Generated stories' Rexall HARs through the real HAR importer
 * (`har-importer-core`'s `harImporter.decode`, which recognizes the traffic
 * through `rexall-be-well-source`, decodes the carebook STU3 dialect to R4,
 * promotes its extensions and adopts the resources), then read the way the
 * medication views read them (`medication-core`).
 *
 * @remarks
 * Every expectation — name, DIN, quantity, supply, repeats, status, sig, the
 * most recent fill's day and the amortized daily dose — is
 * `storyCaseArbitrary`'s own reckoning from the generated inputs, not the
 * model functions the generator calls, so a generator or model change that
 * alters what an import shows fails here.
 */

const RUNS = numRunsFor({ base: 20 })

/** Each property imports every generated HAR: generous, so a slow runner or a scaled-up run count fits. */
const ROUND_TRIP_TIMEOUT_MILLIS = 60_000

/** What one import extracted, source file excluded. */
interface Imported {
  readonly notes: readonly string[]
  readonly unreadableFiles: readonly unknown[]
  readonly resources: readonly FhirResource[]
  readonly requests: readonly MedicationRequestWithId[]
  readonly dispenses: readonly MedicationDispense.Type[]
  readonly patients: readonly Patient.Type[]
}

/** `har` through `harImporter.decode`, as one picked file. */
const importHar = async (har: string): Promise<Imported> => {
  const picked: PickedFile.Type = {
    id: '0:rexall.har',
    fileName: 'rexall.har',
    bytes: new TextEncoder().encode(har),
  }
  const result = await Effect.runPromise(harImporter.decode([picked], defaultHarSettings))
  const resources = result.decoded.sections
    .filter((section) => section.title !== 'Source file')
    .flatMap((section) => section.resources.map((entry) => entry.resource))
  return {
    notes: result.decoded.notes,
    unreadableFiles: result.unreadableFiles,
    resources,
    requests: resources.flatMap((resource) =>
      resource.resourceType === 'MedicationRequest' && resource.id !== null
        ? [{ ...resource, id: resource.id }]
        : []
    ),
    dispenses: resources.flatMap((resource) =>
      resource.resourceType === 'MedicationDispense' ? [resource] : []
    ),
    patients: resources.flatMap((resource) =>
      resource.resourceType === 'Patient' ? [resource] : []
    ),
  }
}

/** One generated case: an as-of date, a story, and the account it is filled under. */
interface Run {
  readonly asOf: DateTime.Utc
  readonly storyCase: StoryCase
  readonly account: RexallAccount
}

const runArbitrary: fc.Arbitrary<Run> = fc.record({
  asOf: asOfArbitrary,
  storyCase: storyCaseArbitrary('person-1'),
  account: rexallAccountArbitrary,
})

/** `check` over each generated case's rendered, then imported, HAR. */
const assertRoundTrip = (check: (run: Run, imported: Imported) => void): Promise<void> =>
  fc.assert(
    fc.asyncProperty(runArbitrary, async (run) => {
      const har = await Effect.runPromise(
        RexallHar.render(run.asOf, run.storyCase.story, run.account)
      )
      check(run, await importHar(har))
    }),
    { numRuns: RUNS }
  )

/** The calendar day `days` from the as-of day, worked out here. */
const isoDateOn = (asOf: DateTime.Utc, days: number): string =>
  DateTime.formatIsoDate(DateTime.add(DateTime.startOf(asOf, 'day'), { days }))

const isoDateOf = (instant: DateTime.Utc | null | undefined): string | null =>
  instant === null || instant === undefined ? null : DateTime.formatIsoDate(instant)

/** The imported request written on `expected`'s day: a generated story writes at most one a day. */
const requestFor = (
  asOf: DateTime.Utc,
  imported: Imported,
  expected: ExpectedPrescription
): MedicationRequestWithId | undefined =>
  imported.requests.find(
    (request) => isoDateOf(request.authoredOn) === isoDateOn(asOf, expected.writtenDay)
  )

/**
 * A dispense's `medicationCodeableConcept`, decoded through fhir-r4's type
 * schema: the `medication[x]` choice is typed `any` on the decoded resource.
 */
const dispenseConceptOf = (
  dispense: MedicationDispense.Type
): typeof CodeableConcept.Schema.Type | null => {
  const slot: unknown = dispense.medicationCodeableConcept
  return Option.getOrNull(
    Schema.decodeUnknownOption(Schema.typeSchema(CodeableConcept.Schema))(slot)
  )
}

/** The dispenses whose `authorizingPrescription` names one of `request`'s carebook identifiers. */
const dispensesAuthorizedBy = (
  imported: Imported,
  request: MedicationRequestWithId
): readonly MedicationDispense.Type[] => {
  const carebookIds = new Set(
    request.identifier.flatMap((identifier) =>
      identifier.system?.href === REXALL_CAREBOOK_SYSTEM && typeof identifier.value === 'string'
        ? [identifier.value]
        : []
    )
  )
  return imported.dispenses.filter((dispense) =>
    dispense.authorizingPrescription.some((reference) => {
      const value = reference.identifier?.value
      return typeof value === 'string' && carebookIds.has(value)
    })
  )
}

describe(
  'RexallHar.render through the HAR importer',
  { timeout: ROUND_TRIP_TIMEOUT_MILLIS },
  () => {
    test('property: claims both XHRs and neither page: one Patient, and a request and dispense per prescription', async () => {
      await assertRoundTrip(({ storyCase }, imported) => {
        expect(imported.unreadableFiles).toEqual([])
        expect(imported.notes).toEqual([
          'Matched no importer: https://letsbewell.ca/sign-in',
          'Matched no importer: https://app.letsbewell.ca/health/prescriptions',
        ])
        const count = storyCase.expected.length
        expect({
          patients: imported.patients.length,
          requests: imported.requests.length,
          dispenses: imported.dispenses.length,
          resources: imported.resources.length,
        }).toEqual({ patients: 1, requests: count, dispenses: count, resources: 1 + 2 * count })
      })
    })

    test('property: the Patient is the person, their age on the as-of day', async () => {
      await assertRoundTrip(({ asOf, storyCase: { story } }, imported) => {
        const [patient] = imported.patients
        expect(patient?.name[0]).toMatchObject({
          given: [story.person.givenName],
          family: story.person.familyName,
        })
        const birthDate = patient?.birthDate
        expect(birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(ageOn(DateTime.unsafeMake(`${birthDate}T00:00:00Z`), asOf)).toBe(story.person.age)
      })
    })

    test('property: every request reads as its generated inputs say', async () => {
      await assertRoundTrip(({ asOf, storyCase }, imported) => {
        for (const expected of storyCase.expected) {
          const request = requestFor(asOf, imported, expected)
          expect(request, expected.key).toBeDefined()
          if (request === undefined) continue
          expect({
            name: displayNameOf(request),
            din: dinOf(request),
            quantity: request.dispenseRequest?.quantity?.value,
            supplyDays: request.dispenseRequest?.expectedSupplyDuration?.value,
            repeatsAllowed: repeatsAllowedOf(request),
            repeatsAvailable: repeatsAvailableOf(request),
            status: request.status,
            sig: request.note[0]?.text,
          }).toEqual({
            name: expected.name,
            din: expected.din,
            quantity: expected.quantity,
            supplyDays: expected.supplyDays,
            repeatsAllowed: expected.repeatsAllowed,
            repeatsAvailable: expected.repeatsAvailable,
            status: expected.status,
            sig: expected.sig,
          })
        }
      })
    })

    test('property: every request amortizes to its daily dose', async () => {
      await assertRoundTrip(({ asOf, storyCase }, imported) => {
        const { regimens, undated, dropped } = medicationRequestsToDoseRegimens(imported.requests)
        expect({ regimens: regimens.length, undated, dropped }).toEqual({
          regimens: storyCase.expected.length,
          undated: 0,
          dropped: 0,
        })
        for (const expected of storyCase.expected) {
          const request = requestFor(asOf, imported, expected)
          const regimen = regimens.find(({ requestId }) => requestId === request?.id)
          expect(regimen, expected.key).toMatchObject({
            unit: expected.dailyDose.unit,
            per: 'd',
            derivation: 'amortized',
          })
          expect(regimen?.amount).toBeCloseTo(expected.dailyDose.value, 9)
        }
      })
    })

    test('property: every request has its most recent fill as one completed dispense of its product', async () => {
      await assertRoundTrip(({ asOf, storyCase }, imported) => {
        const subject = `Patient/${imported.patients[0]?.id}`
        for (const expected of storyCase.expected) {
          const request = requestFor(asOf, imported, expected)
          const authorized = request === undefined ? [] : dispensesAuthorizedBy(imported, request)
          expect(authorized, expected.key).toHaveLength(1)
          const [dispense] = authorized
          const concept = dispense === undefined ? null : dispenseConceptOf(dispense)
          expect({
            name: concept?.text,
            din: concept?.coding.find(Coding.isInSystem(CanadianCodingSystem.Din))?.code,
            handedOver: isoDateOf(dispense?.whenHandedOver),
            quantity: dispense?.quantity?.value,
            supplyDays: dispense?.daysSupply?.value,
            status: dispense?.status,
            subject: dispense?.subject?.reference,
          }).toEqual({
            name: expected.name,
            din: expected.din,
            handedOver: isoDateOn(asOf, expected.lastFillDay),
            quantity: expected.quantity,
            supplyDays: expected.supplyDays,
            status: 'completed',
            subject,
          })
        }
      })
    })
  }
)
