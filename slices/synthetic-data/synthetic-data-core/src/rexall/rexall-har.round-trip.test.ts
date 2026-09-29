import { DateTime, Effect } from 'effect'
import type { FhirResource, MedicationDispense, Patient } from 'fhir-r4/resources'
import { defaultHarSettings, harImporter } from 'har-importer-core'
import type { PickedFile } from 'importer-fundamentals'
import {
  dinOf,
  displayNameOf,
  medicationRequestsToDoseRegimens,
  repeatsAllowedOf,
  repeatsAvailableOf,
  type MedicationRequestWithId,
} from 'medication-core/fhir'
import { describe, expect, test } from 'vite-plus/test'

import { warrenRexallAccount, warrenStory } from '../ashford/warren.ts'
import * as StoryDay from '../story-day.ts'
import * as RexallHar from './rexall-har.ts'

/**
 * Warren's Rexall HAR through the real HAR importer (`har-importer-core`'s
 * `harImporter.decode`, which recognizes the traffic through
 * `rexall-be-well-source`, decodes the carebook STU3 dialect to R4, promotes
 * its extensions and adopts the resources), then read the way the medication
 * views read it (`medication-core`).
 *
 * @remarks
 * The expectations are Warren's story as the epic (#787) tells it, written
 * out — names, DINs, quantities, supply, repeats, statuses and the amortized
 * daily dose — not read back from the story, so a renderer or model change
 * that alters what an import shows fails here.
 */

/** An as-of date well inside the range the property tests sweep. */
const AS_OF = DateTime.unsafeMake('2026-09-28T12:00:00Z')

interface ExpectedPrescription {
  /** The day it was written, relative to the as-of day: how the test finds it. */
  readonly writtenDay: number
  readonly name: string
  readonly din: string
  readonly quantity: number
  readonly supplyDays: number
  readonly repeatsAllowed: number
  readonly repeatsAvailable: number
  readonly status: 'active' | 'completed' | 'stopped'
  readonly dailyDoseMg: number
  /** The most recent fill: the day its dispense was handed over. */
  readonly lastFillDay: number
  readonly sig: string
}

const WARFARIN_5 = 'TAKE 1 TABLET (=5MG) BY MOUTH ONCE DAILY'
const WARFARIN_4 = 'TAKE 1 TABLET (=4MG) BY MOUTH ONCE DAILY'
const METFORMIN_500 = 'TAKE 1 TABLET (=500MG) BY MOUTH TWICE DAILY WITH MEALS'
const METFORMIN_1000 = 'TAKE 2 TABLETS (=1000MG) BY MOUTH TWICE DAILY WITH MEALS'

const EXPECTED: readonly ExpectedPrescription[] = [
  // Metformin 500 mg twice daily, replaced by 1000 mg twice daily.
  {
    writtenDay: -510,
    name: 'Metformin 500 mg tablet',
    din: '02257726',
    quantity: 180,
    supplyDays: 90,
    repeatsAllowed: 3,
    repeatsAvailable: 1,
    status: 'stopped',
    dailyDoseMg: 1000,
    lastFillDay: -324,
    sig: METFORMIN_500,
  },
  // Warfarin 5 mg, cut to 4 mg after INR 3.8.
  {
    writtenDay: -480,
    name: 'Warfarin 5 mg tablet',
    din: '02242685',
    quantity: 30,
    supplyDays: 30,
    repeatsAllowed: 5,
    repeatsAvailable: 2,
    status: 'stopped',
    dailyDoseMg: 5,
    lastFillDay: -387,
    sig: WARFARIN_5,
  },
  // Warfarin 4 mg, every repeat used.
  {
    writtenDay: -384,
    name: 'Warfarin 4 mg tablet',
    din: '02242684',
    quantity: 30,
    supplyDays: 30,
    repeatsAllowed: 5,
    repeatsAvailable: 0,
    status: 'completed',
    dailyDoseMg: 4,
    lastFillDay: -230,
    sig: WARFARIN_4,
  },
  // Metformin 1000 mg twice daily as two 500 mg tablets (Teva).
  {
    writtenDay: -296,
    name: 'Metformin 500 mg tablet',
    din: '02257726',
    quantity: 360,
    supplyDays: 90,
    repeatsAllowed: 3,
    repeatsAvailable: 1,
    status: 'stopped',
    dailyDoseMg: 2000,
    lastFillDay: -113,
    sig: METFORMIN_1000,
  },
  // Warfarin 4 mg renewed, then held.
  {
    writtenDay: -201,
    name: 'Warfarin 4 mg tablet',
    din: '02242684',
    quantity: 30,
    supplyDays: 30,
    repeatsAllowed: 5,
    repeatsAvailable: 2,
    status: 'stopped',
    dailyDoseMg: 4,
    lastFillDay: -109,
    sig: WARFARIN_4,
  },
  // Clarithromycin 500 mg twice daily for 7 days.
  {
    writtenDay: -101,
    name: 'Clarithromycin 500 mg tablet',
    din: '02274752',
    quantity: 14,
    supplyDays: 7,
    repeatsAllowed: 0,
    repeatsAvailable: 0,
    status: 'completed',
    dailyDoseMg: 1000,
    lastFillDay: -101,
    sig: 'TAKE 1 TABLET (=500MG) BY MOUTH TWICE DAILY FOR 7 DAYS',
  },
  // Warfarin 4 mg resumed after the hold.
  {
    writtenDay: -91,
    name: 'Warfarin 4 mg tablet',
    din: '02242684',
    quantity: 30,
    supplyDays: 30,
    repeatsAllowed: 5,
    repeatsAvailable: 3,
    status: 'active',
    dailyDoseMg: 4,
    lastFillDay: -16,
    sig: WARFARIN_4,
  },
  // Metformin 1000 mg twice daily, switched to Sandoz.
  {
    writtenDay: -23,
    name: 'Metformin 500 mg tablet',
    din: '02246820',
    quantity: 360,
    supplyDays: 90,
    repeatsAllowed: 1,
    repeatsAvailable: 1,
    status: 'active',
    dailyDoseMg: 2000,
    lastFillDay: -23,
    sig: METFORMIN_1000,
  },
]

const pickedHar: PickedFile.Type = {
  id: '0:warren-rexall.har',
  fileName: 'warren-rexall.har',
  bytes: new TextEncoder().encode(RexallHar.render(AS_OF, warrenStory, warrenRexallAccount)),
}

const decodeResult = await Effect.runPromise(harImporter.decode([pickedHar], defaultHarSettings))

/** Every resource the import extracted, source file excluded. */
const imported: readonly FhirResource[] = decodeResult.decoded.sections
  .filter((section) => section.title !== 'Source file')
  .flatMap((section) => section.resources.map((entry) => entry.resource))

const requests: readonly MedicationRequestWithId[] = imported.flatMap((resource) =>
  resource.resourceType === 'MedicationRequest' && resource.id !== null
    ? [{ ...resource, id: resource.id }]
    : []
)
const dispenses: readonly MedicationDispense.Type[] = imported.flatMap((resource) =>
  resource.resourceType === 'MedicationDispense' ? [resource] : []
)
const patients: readonly Patient.Type[] = imported.flatMap((resource) =>
  resource.resourceType === 'Patient' ? [resource] : []
)

const isoDateOf = (instant: DateTime.Utc | null | undefined): string | null =>
  instant === null || instant === undefined ? null : DateTime.formatIsoDate(instant)

/** The imported request written on `writtenDay`. */
const requestWrittenOn = (writtenDay: number): MedicationRequestWithId | undefined =>
  requests.find(
    (request) => isoDateOf(request.authoredOn) === StoryDay.toIsoDate(AS_OF, writtenDay)
  )

describe("Warren's Rexall HAR through the HAR importer", () => {
  test('reads, claiming both XHRs and neither page', () => {
    expect(decodeResult.unreadableFiles).toEqual([])
    expect(decodeResult.decoded.notes).toEqual([
      'Matched no importer: https://letsbewell.ca/sign-in',
      'Matched no importer: https://app.letsbewell.ca/health/prescriptions',
    ])
  })

  test('yields his profile as one Patient', () => {
    expect(patients).toHaveLength(1)
    expect(patients[0]?.name?.[0]).toMatchObject({ given: ['Warren'], family: 'Ashford' })
    expect(patients[0]?.birthDate).toBe('1948-05-08')
  })

  test('yields one MedicationRequest and one MedicationDispense per prescription', () => {
    expect(requests).toHaveLength(EXPECTED.length)
    expect(dispenses).toHaveLength(EXPECTED.length)
    expect(imported).toHaveLength(1 + 2 * EXPECTED.length)
  })

  describe.each(EXPECTED.map((expected) => [expected.writtenDay, expected]))(
    'the prescription written on day %i',
    (_writtenDay, expected) => {
      test('reads as the story tells it', () => {
        const request = requestWrittenOn(expected.writtenDay)
        expect(request).toBeDefined()
        if (request === undefined) return
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
      })

      test("amortizes to the story's daily dose", () => {
        const request = requestWrittenOn(expected.writtenDay)
        const [regimen] = medicationRequestsToDoseRegimens(
          request === undefined ? [] : [request]
        ).regimens
        expect(regimen).toMatchObject({
          amount: expected.dailyDoseMg,
          unit: 'mg',
          per: 'd',
          derivation: 'amortized',
        })
      })

      test('has its most recent fill as a completed dispense', () => {
        const lastFillDate = StoryDay.toIsoDate(AS_OF, expected.lastFillDay)
        const matching = dispenses.filter(
          (dispense) =>
            isoDateOf(dispense.whenHandedOver) === lastFillDate &&
            dispense.quantity?.value === expected.quantity &&
            dispense.daysSupply?.value === expected.supplyDays
        )
        expect(matching).toHaveLength(1)
        expect(matching[0]?.status).toBe('completed')
      })
    }
  )

  test('reads warfarin as 5 mg, then 4 mg a day, and metformin as 1000, then 2000 mg a day', () => {
    const { regimens, undated, dropped } = medicationRequestsToDoseRegimens(requests)
    expect({ undated, dropped }).toEqual({ undated: 0, dropped: 0 })
    const dosesOf = (normalizedName: string): readonly number[] =>
      regimens
        .filter((regimen) => regimen.normalizedName === normalizedName)
        .toSorted((left, right) => left.start.epochMillis - right.start.epochMillis)
        .map((regimen) => regimen.amount)
    expect(dosesOf('warfarin tablet')).toEqual([5, 4, 4, 4])
    expect(dosesOf('metformin tablet')).toEqual([1000, 2000, 2000])
    expect(dosesOf('clarithromycin tablet')).toEqual([1000])
  })
})
