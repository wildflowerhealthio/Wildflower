import { DateTime } from 'effect'
import * as fc from 'fast-check'

import type * as DrugProduct from './drug-product.ts'
import type { LabDraw } from './lab-draw.ts'
import type { LabRequisition } from './lifelabs/lab-requisition.ts'
import type { Laboratory, LifeLabsTest, PrintedRange } from './lifelabs/laboratory.ts'
import type * as Person from './person.ts'
import type * as Prescription from './prescription.ts'
import type { RexallAccount } from './rexall/rexall-account.ts'
import type { ShoppersAccount } from './shoppers/shoppers-account.ts'
import type { SourcePatient } from './source-patient.ts'
import type { StoryDay } from './story-day.ts'
import type { Story } from './story.ts'

/**
 * Arbitraries for the story model: as-of instants, people, drug products,
 * prescriptions and whole stories, and the LifeLabs laboratories, lab draws
 * and requisitions their lab results are printed with. Each story comes paired with what a
 * pharmacy record of it must say, worked out here from the generated inputs
 * rather than by the model's own functions, so a round-trip test compares an
 * importer's output against an independent reckoning.
 */

/**
 * An as-of instant anywhere in 2000–2099, at any time of day: the range a
 * data set is plausibly dated from, wide enough that birthdays and fills
 * cross February 29th.
 */
const asOfArbitrary: fc.Arbitrary<DateTime.Utc> = fc
  .integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2099, 11, 31) })
  .map((epochMillis) => DateTime.unsafeMake(epochMillis))

/** Whole years from `birth` to `on`, as a birthday count: the tests' own reckoning. */
const ageOn = (birth: DateTime.Utc, on: DateTime.Utc): number => {
  const birthParts = DateTime.toPartsUtc(birth)
  const onParts = DateTime.toPartsUtc(on)
  const birthdayReached =
    onParts.month > birthParts.month ||
    (onParts.month === birthParts.month && onParts.day >= birthParts.day)
  return onParts.year - birthParts.year - (birthdayReached ? 0 : 1)
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const GIVEN_NAMES = ['Alex', 'Avery', 'Casey', 'Jordan', 'Morgan', 'Riley', 'Robin', 'Sam']
const FAMILY_NAMES = ['Dubois', 'Lindqvist', 'Marchetti', 'Nakamura', 'Okoye', 'Pereira', 'Singh']

/** A Canadian postal code (`A1A 1A1`), from the letters Canada Post uses. */
const postalCodeArbitrary: fc.Arbitrary<string> = fc.stringMatching(
  /^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z] [0-9][ABCEGHJ-NPRSTV-Z][0-9]$/
)

/** A person keyed `key`, with any name, gender, age and birthday. */
const personArbitrary = (key: string): fc.Arbitrary<Person.Person> =>
  fc
    .record({
      givenName: fc.constantFrom(...GIVEN_NAMES),
      familyName: fc.constantFrom(...FAMILY_NAMES),
      gender: fc.constantFrom('male' as const, 'female' as const),
      age: fc.integer({ min: 0, max: 100 }),
      daysSinceBirthday: fc.integer({ min: 0, max: 364 }),
      postalCode: postalCodeArbitrary,
    })
    .map((fields) => ({
      ...fields,
      key,
      email: `${fields.givenName}.${fields.familyName}.${key}@example.com`.toLowerCase(),
    }))

// ---------------------------------------------------------------------------
// Drug products
// ---------------------------------------------------------------------------

const GENERIC_STEMS = ['Alva', 'Bris', 'Cora', 'Dela', 'Fira', 'Lumi', 'Mora', 'Orla', 'Tavo']
const GENERIC_SUFFIXES = ['azole', 'dipine', 'formin', 'mycin', 'olol', 'pril', 'sartan', 'statin']

interface Manufacturer {
  /** What the brand name leads with (`Apo-…`). */
  readonly prefix: string
  readonly company: string
}

const MANUFACTURERS: readonly Manufacturer[] = [
  { prefix: 'Apo', company: 'Apotex Inc' },
  { prefix: 'Auro', company: 'Auro Pharma Inc' },
  { prefix: 'Mylan', company: 'Mylan Pharmaceuticals ULC' },
  { prefix: 'pms', company: 'Pharmascience Inc' },
  { prefix: 'Sandoz', company: 'Sandoz Canada Inc' },
  { prefix: 'Teva', company: 'Teva Canada Limited' },
]

/**
 * Strengths a tablet is marketed in, ascending, by unit: milligram strengths
 * (fractional ones included) and the microgram strengths of thyroid-style
 * tablets. A dose change steps along its unit's list.
 */
const STRENGTH_VALUES: Readonly<Record<DrugProduct.Strength['unit'], readonly number[]>> = {
  mg: [0.5, 1, 2.5, 5, 10, 12.5, 20, 25, 40, 50, 250, 500, 850],
  mcg: [25, 50, 75, 88, 100, 112, 125, 150, 200],
}

/** A plausible DIN: eight digits, leading zeros kept, in the `00…` / `02…` ranges most carry. */
const dinArbitrary: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom('00', '02'), fc.integer({ min: 0, max: 999_999 }))
  .map(([prefix, serial]) => `${prefix}${String(serial).padStart(6, '0')}`)

/** A made-up generic name with a real drug-class suffix (`Alvastatin`). */
const genericNameArbitrary: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...GENERIC_STEMS), fc.constantFrom(...GENERIC_SUFFIXES))
  .map(([stem, suffix]) => `${stem}${suffix}`)

const strengthArbitrary: fc.Arbitrary<DrugProduct.Strength> = fc
  .constantFrom<DrugProduct.Strength['unit']>('mg', 'mcg')
  .chain((unit) => fc.constantFrom(...STRENGTH_VALUES[unit]).map((value) => ({ value, unit })))

/**
 * The strength one step up or down `strength`'s list — a titration, not a jump
 * across the range. `pick` chooses the direction; at either end of the list
 * the only neighbour is taken.
 */
const titratedStrength = (strength: DrugProduct.Strength, pick: number): DrugProduct.Strength => {
  const ladder = STRENGTH_VALUES[strength.unit]
  const index = ladder.indexOf(strength.value)
  const up = ladder[index + 1]
  const down = ladder[index - 1]
  const value = (pick % 2 === 0 ? (up ?? down) : (down ?? up)) ?? strength.value
  return { value, unit: strength.unit }
}

/**
 * A product: listed in the DPD under `databaseKey` as its `drugCode`, or — a
 * natural health product — licensed in the LNHPD under it as its `lnhpdId`.
 */
const productOf = (
  genericName: string,
  strength: DrugProduct.Strength,
  manufacturer: Manufacturer,
  din: string,
  databaseKey: number,
  naturalHealthProduct: boolean
): DrugProduct.DrugProduct => {
  const marketed = {
    din,
    brandName: `${manufacturer.prefix}-${genericName}`,
    genericName,
    strength,
    form: 'tablet' as const,
    company: manufacturer.company,
  }
  return naturalHealthProduct
    ? { ...marketed, drugCode: null, lnhpdId: databaseKey }
    : { ...marketed, drugCode: databaseKey }
}

/** Whether one in ten generated drugs is a natural health product. */
const naturalHealthProductArbitrary: fc.Arbitrary<boolean> = fc
  .integer({ min: 0, max: 9 })
  .map((draw) => draw === 0)

/** Any tablet, of any strength, by any manufacturer, now and then a natural health product. */
const productArbitrary: fc.Arbitrary<DrugProduct.DrugProduct> = fc
  .record({
    genericName: genericNameArbitrary,
    strength: strengthArbitrary,
    manufacturer: fc.constantFrom(...MANUFACTURERS),
    din: dinArbitrary,
    databaseKey: fc.integer({ min: 1, max: 199_999 }),
    naturalHealthProduct: naturalHealthProductArbitrary,
  })
  .map(({ genericName, strength, manufacturer, din, databaseKey, naturalHealthProduct }) =>
    productOf(genericName, strength, manufacturer, din, databaseKey, naturalHealthProduct)
  )

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

const dosingArbitrary: fc.Arbitrary<Prescription.Dosing> = fc.record({
  tabletsPerDose: fc.constantFrom<Prescription.TabletsPerDose>(0.5, 1, 2),
  dosesPerDay: fc.constantFrom(1 as const, 2 as const),
  // No course length (`FOR 10 DAYS`): a story's prescriptions repeat and renew.
  direction: fc.constantFrom(null, 'WITH MEALS', 'AT BEDTIME', 'ON AN EMPTY STOMACH'),
})

const prescriberArbitrary: fc.Arbitrary<Prescription.Prescriber> = fc
  .tuple(fc.constantFrom('A', 'J', 'M', 'N'), fc.constantFrom(...FAMILY_NAMES))
  .map(([initial, familyName]) => ({
    key: `${initial}-${familyName}`.toLowerCase(),
    display: `DR ${initial} ${familyName.toUpperCase()}`,
  }))

/** The label a pharmacy list leads with, written out: `'Alvastatin 20 mg tablet'`. */
const expectedNameOf = (product: DrugProduct.DrugProduct): string =>
  `${product.genericName} ${product.strength.value} ${product.strength.unit} tablet`

const TABLETS_WRITTEN: Readonly<Record<Prescription.TabletsPerDose, string>> = {
  0.5: '1/2 TABLET',
  1: '1 TABLET',
  2: '2 TABLETS',
}

/** The sig, written out: `'TAKE 2 TABLETS (=40MG) BY MOUTH TWICE DAILY WITH MEALS'`. */
const expectedSigOf = (dosing: Prescription.Dosing, strength: DrugProduct.Strength): string =>
  [
    'TAKE',
    TABLETS_WRITTEN[dosing.tabletsPerDose],
    `(=${dosing.tabletsPerDose * strength.value}${strength.unit.toUpperCase()})`,
    'BY MOUTH',
    dosing.dosesPerDay === 1 ? 'ONCE DAILY' : 'TWICE DAILY',
    ...(dosing.direction === null ? [] : [dosing.direction]),
  ].join(' ')

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/** Why a prescription after the first of its drug was written. */
type FollowUpReason = Exclude<Prescription.WrittenReason, 'start'>

/**
 * What one prescription's pharmacy record must say, worked out from the
 * generated inputs by this module's own arithmetic.
 */
interface ExpectedPrescription {
  readonly key: string
  readonly writtenDay: StoryDay
  /** Every fill's day, ascending. */
  readonly fillDays: readonly StoryDay[]
  /** The most recent fill's day. */
  readonly lastFillDay: StoryDay
  /** Generic name, strength and form: `'Alvastatin 20 mg tablet'`. */
  readonly name: string
  /** The product on the label now: the most recent fill's. */
  readonly brandName: string
  readonly din: string
  /** The DIN each fill dispensed, in fill order: an interchange changes it partway. */
  readonly fillDins: readonly string[]
  /** The prescription for the same drug this one continues, or `null` for the first. */
  readonly previousKey: string | null
  /** The prescription for the same drug that continues this one, or `null` for the last. */
  readonly nextKey: string | null
  /** Tablets per fill. */
  readonly quantity: number
  readonly supplyDays: number
  readonly repeatsAllowed: number
  readonly repeatsAvailable: number
  readonly status: Prescription.Status
  readonly sig: string
  /** The daily dose one fill amortizes to, in the strength's unit. */
  readonly dailyDose: DrugProduct.Strength
}

/** A generated story and, per prescription (in story order), what its records must say. */
interface StoryCase {
  readonly story: Story
  readonly expected: readonly ExpectedPrescription[]
}

/** One prescription's free inputs; its episode fixes its days, product and dosing from them. */
interface StepInputs {
  readonly dosing: Prescription.Dosing
  readonly supplyDays: number
  readonly repeatsAllowed: number
  /** Taken modulo `repeatsAllowed + 1`: how many repeats were filled. */
  readonly refillsDraw: number
  /** Days past due each refill was picked up; a long one is a missed fill. */
  readonly refillDaysLate: readonly number[]
  readonly firstFillDelay: number
  /** Taken modulo the supply: how far into the last fill it ended. */
  readonly endAfterDraw: number
  readonly holdDays: number
  /** How early a renewal is written before the last fill runs out. */
  readonly renewEarly: number
  /**
   * For a dose change: whether it steps to a neighbouring strength, else it
   * takes a different number of tablets a day of the same product (falling
   * back to a new strength when the drawn dosing takes as many).
   */
  readonly newStrength: boolean
  /** Picks the new strength's direction or the new manufacturer. */
  readonly pick: number
  readonly din: string
  readonly databaseKey: number
  /**
   * Whether the pharmacy interchanges the product on a refill, and which: taken
   * modulo the refills (a prescription filled once has none to switch on).
   */
  readonly interchangeDraw: number | null
  readonly interchangeDin: string
  readonly prescriber: Prescription.Prescriber
}

/** At most this many refills: {@link StepInputs.refillDaysLate} has one entry per refill. */
const MAX_REPEATS = 5

const stepInputsArbitrary: fc.Arbitrary<StepInputs> = fc.record({
  dosing: dosingArbitrary,
  // Even, so half a tablet a day still fills whole tablets.
  supplyDays: fc.constantFrom(10, 14, 28, 30, 60, 90),
  repeatsAllowed: fc.integer({ min: 0, max: MAX_REPEATS }),
  refillsDraw: fc.nat({ max: 60 }),
  refillDaysLate: fc.array(
    fc.oneof(
      { weight: 3, arbitrary: fc.constant(0) },
      { weight: 2, arbitrary: fc.integer({ min: 1, max: 3 }) },
      { weight: 1, arbitrary: fc.integer({ min: 10, max: 30 }) }
    ),
    { minLength: MAX_REPEATS, maxLength: MAX_REPEATS }
  ),
  firstFillDelay: fc.integer({ min: 0, max: 3 }),
  endAfterDraw: fc.nat({ max: 1000 }),
  holdDays: fc.integer({ min: 2, max: 14 }),
  renewEarly: fc.integer({ min: 0, max: 5 }),
  newStrength: fc.boolean(),
  pick: fc.nat({ max: 1000 }),
  din: dinArbitrary,
  databaseKey: fc.integer({ min: 1, max: 199_999 }),
  interchangeDraw: fc.oneof(
    { weight: 4, arbitrary: fc.constant(null) },
    { weight: 1, arbitrary: fc.nat({ max: 1000 }) }
  ),
  interchangeDin: dinArbitrary,
  prescriber: prescriberArbitrary,
})

/** One drug's prescriptions: why each after the first was written, and their inputs. */
interface EpisodeInputs {
  readonly genericName: string
  readonly strength: DrugProduct.Strength
  readonly manufacturer: Manufacturer
  readonly naturalHealthProduct: boolean
  readonly followUps: readonly FollowUpReason[]
  /** One per prescription: `followUps.length + 1`. */
  readonly steps: readonly StepInputs[]
  /** Whether the last prescription is stopped (else it runs, or ran out). */
  readonly stoppedAtEnd: boolean
  /** Days from the story's first day to this episode's start. */
  readonly startOffset: number
}

const episodeInputsArbitrary: fc.Arbitrary<EpisodeInputs> = fc
  .record({
    genericName: genericNameArbitrary,
    strength: strengthArbitrary,
    manufacturer: fc.constantFrom(...MANUFACTURERS),
    naturalHealthProduct: naturalHealthProductArbitrary,
    followUps: fc.array(
      fc.constantFrom<FollowUpReason>('dose-change', 'renewal', 'resume', 'generic-switch'),
      { maxLength: 3 }
    ),
    stoppedAtEnd: fc.boolean(),
    startOffset: fc.integer({ min: 0, max: 300 }),
  })
  .chain((episode) =>
    fc
      .array(stepInputsArbitrary, {
        minLength: episode.followUps.length + 1,
        maxLength: episode.followUps.length + 1,
      })
      .map((steps) => ({ ...episode, steps }))
  )

/** A prescription on its episode's own clock, before the story shifts it onto its days. */
interface LaidOut {
  readonly prescription: Prescription.Prescription
  /** Repeats filled after the first fill. */
  readonly refills: number
  readonly previousKey: string | null
  readonly nextKey: string | null
}

/** A DIN for a new product that is never the one it replaces. */
const newDinOf = (din: string, replaced: DrugProduct.DrugProduct): string =>
  din === replaced.din ? `${din.slice(0, 7)}${(Number(din.slice(7)) + 1) % 10}` : din

/** Another manufacturer's product at `product`'s strength, picked by `pick`. */
const interchangeableWith = (
  product: DrugProduct.DrugProduct,
  pick: number,
  din: string,
  databaseKey: number
): DrugProduct.DrugProduct => {
  const others = MANUFACTURERS.filter(({ company }) => company !== product.company)
  const maker = others[pick % others.length] ?? MANUFACTURERS[0]
  return maker === undefined
    ? product
    : productOf(
        product.genericName,
        product.strength,
        maker,
        newDinOf(din, product),
        databaseKey,
        product.drugCode === null
      )
}

/** Tablets a dosing takes each day. */
const dailyTabletsOf = (dosing: Prescription.Dosing): number =>
  dosing.tabletsPerDose * dosing.dosesPerDay

/**
 * The product a follow-up prescription is written for, from the one it
 * follows: a new strength of it when `newStrength`, another manufacturer's for
 * a generic switch, else the same product.
 */
const productAfter = (
  reason: Prescription.WrittenReason,
  previous: DrugProduct.DrugProduct,
  step: StepInputs,
  newStrength: boolean
): DrugProduct.DrugProduct => {
  const sameMaker =
    MANUFACTURERS.find(({ company }) => company === previous.company) ?? MANUFACTURERS[0]
  if (reason === 'dose-change' && newStrength && sameMaker !== undefined) {
    return productOf(
      previous.genericName,
      titratedStrength(previous.strength, step.pick),
      sameMaker,
      newDinOf(step.din, previous),
      step.databaseKey,
      previous.drugCode === null
    )
  }
  if (reason === 'generic-switch') {
    return interchangeableWith(previous, step.pick, step.din, step.databaseKey)
  }
  return previous
}

/**
 * How a prescription ends, given why the next of its drug is written (or,
 * last of its episode, whether it is stopped): a renewal follows one that ran
 * out, a resume follows a hold, a dose change or generic switch ends it for
 * the same reason.
 */
const endedBefore = (
  nextReason: FollowUpReason | undefined,
  stoppedAtEnd: boolean,
  endDay: StoryDay
): Prescription.Prescription['ended'] => {
  if (nextReason === undefined) return stoppedAtEnd ? { day: endDay, reason: 'stop' } : null
  if (nextReason === 'renewal') return null
  return { day: endDay, reason: nextReason === 'resume' ? 'hold' : nextReason }
}

/**
 * The day the next prescription is written: a renewal a few days before the
 * last fill runs out, a resume some days after the hold, a dose change or
 * generic switch the day this one ends.
 */
const nextWrittenDay = (
  nextReason: FollowUpReason | undefined,
  step: StepInputs,
  lastFillDay: StoryDay,
  endDay: StoryDay
): StoryDay => {
  if (nextReason === 'renewal') return lastFillDay + Math.max(1, step.supplyDays - step.renewEarly)
  if (nextReason === 'resume') return endDay + step.holdDays
  return endDay
}

/**
 * Lay out one episode: each prescription's product and dosing follow from why
 * it was written, its fills from its refill cadence, and its end — and the
 * next one's written day — from why the next was written. A renewal follows a
 * prescription whose repeats are all used; a resume follows a hold by a few
 * days; a dose change or generic switch is written the day the one it
 * replaces ends. A dose change always changes the daily dose: either the
 * strength steps while the dosing stays, or the dosing's daily tablets change
 * while the product stays.
 */
const layOutEpisode = (episodeKey: string, episode: EpisodeInputs): readonly LaidOut[] => {
  const [first] = episode.steps
  if (first === undefined) return []
  const laidOut: LaidOut[] = []
  let writtenDay: StoryDay = episode.startOffset
  let product = productOf(
    episode.genericName,
    episode.strength,
    episode.manufacturer,
    first.din,
    first.databaseKey,
    episode.naturalHealthProduct
  )
  let dosing = first.dosing
  for (const [index, step] of episode.steps.entries()) {
    const reason = index === 0 ? 'start' : (episode.followUps[index - 1] ?? 'renewal')
    const nextReason = episode.followUps[index]
    const redosed =
      reason === 'dose-change' &&
      !step.newStrength &&
      dailyTabletsOf(step.dosing) !== dailyTabletsOf(dosing)
    product = productAfter(reason, product, step, reason === 'dose-change' && !redosed)
    if (redosed) dosing = step.dosing
    const refills =
      nextReason === 'renewal' ? step.repeatsAllowed : step.refillsDraw % (step.repeatsAllowed + 1)
    const fillDays = step.refillDaysLate
      .slice(0, refills)
      .reduce<readonly StoryDay[]>(
        (days, daysLate) => [...days, (days.at(-1) ?? 0) + step.supplyDays + daysLate],
        [writtenDay + step.firstFillDelay]
      )
    const lastFillDay = fillDays.at(-1) ?? writtenDay
    const endDay = lastFillDay + 1 + (step.endAfterDraw % step.supplyDays)
    const ended = endedBefore(nextReason, episode.stoppedAtEnd, endDay)
    const interchangeFillDay =
      step.interchangeDraw === null || refills === 0
        ? undefined
        : fillDays[1 + (step.interchangeDraw % refills)]
    const key = `${episodeKey}-${index + 1}`
    laidOut.push({
      refills,
      previousKey: index === 0 ? null : `${episodeKey}-${index}`,
      nextKey: nextReason === undefined ? null : `${episodeKey}-${index + 2}`,
      prescription: {
        key,
        product,
        dosing,
        supplyDaysPerFill: step.supplyDays,
        repeatsAllowed: step.repeatsAllowed,
        prescriber: step.prescriber,
        written: { day: writtenDay, reason },
        ended,
        fillDays,
        ...(interchangeFillDay === undefined
          ? {}
          : {
              interchange: {
                fromFillDay: interchangeFillDay,
                product: interchangeableWith(
                  product,
                  step.pick + 1,
                  step.interchangeDin,
                  step.databaseKey + 1
                ),
              },
            }),
      },
    })
    writtenDay = nextWrittenDay(nextReason, step, lastFillDay, endDay)
  }
  return laidOut
}

/** Every day a prescription's record carries. */
const eventDaysOf = (prescription: Prescription.Prescription): readonly StoryDay[] => [
  prescription.written.day,
  ...prescription.fillDays,
  ...(prescription.ended === null ? [] : [prescription.ended.day]),
]

const shifted = (laidOut: LaidOut, days: number): LaidOut => {
  const { prescription } = laidOut
  return {
    ...laidOut,
    prescription: {
      ...prescription,
      written: { ...prescription.written, day: prescription.written.day + days },
      ended:
        prescription.ended === null
          ? null
          : { ...prescription.ended, day: prescription.ended.day + days },
      fillDays: prescription.fillDays.map((day) => day + days),
      ...(prescription.interchange === undefined
        ? {}
        : {
            interchange: {
              ...prescription.interchange,
              fromFillDay: prescription.interchange.fromFillDay + days,
            },
          }),
    },
  }
}

/** What a prescription's record must say, from its generated fields by this module's arithmetic. */
const expectedOf = ({
  prescription,
  refills,
  previousKey,
  nextKey,
}: LaidOut): ExpectedPrescription => {
  const { product, dosing, supplyDaysPerFill, repeatsAllowed, interchange } = prescription
  const fillProducts = prescription.fillDays.map((day) =>
    interchange !== undefined && day >= interchange.fromFillDay ? interchange.product : product
  )
  const onLabel = fillProducts.at(-1) ?? product
  const tabletsPerDay = dosing.tabletsPerDose * dosing.dosesPerDay
  const lastFillDay = prescription.fillDays.at(-1) ?? prescription.written.day
  const repeatsAvailable = repeatsAllowed - refills
  const runsPastAsOf = repeatsAvailable > 0 || lastFillDay + supplyDaysPerFill > 0
  const unended: Prescription.Status = runsPastAsOf ? 'active' : 'completed'
  return {
    key: prescription.key,
    writtenDay: prescription.written.day,
    fillDays: prescription.fillDays,
    lastFillDay,
    name: expectedNameOf(onLabel),
    brandName: onLabel.brandName,
    din: onLabel.din,
    fillDins: fillProducts.map(({ din }) => din),
    previousKey,
    nextKey,
    quantity: tabletsPerDay * supplyDaysPerFill,
    supplyDays: supplyDaysPerFill,
    repeatsAllowed,
    repeatsAvailable,
    status: prescription.ended === null ? unended : 'stopped',
    sig: expectedSigOf(dosing, product.strength),
    dailyDose: { value: tabletsPerDay * product.strength.value, unit: product.strength.unit },
  }
}

/**
 * A story for the person keyed `personKey`: one to four drugs, each an
 * episode of one to four prescriptions — a start, then dose changes (to a new
 * strength, or a new dosing of the same tablet), renewals once the repeats
 * run out, holds and resumes, and generic switches to another manufacturer —
 * with refills mostly on time, some a few days late, some missed for weeks.
 *
 * @remarks
 * The whole story is shifted so its last event falls before the as-of day,
 * leaving some prescriptions running on it and some long done. Every
 * prescription is filled at least once; no two are written, or last filled,
 * on the same day, so a test can find a record by either date; and each drug
 * has its own generic name, so a drug's prescriptions are one episode. Now
 * and then a prescription is interchanged to another manufacturer's product
 * on a refill, a dose is half a tablet, or a drug is a natural health
 * product. Lab draws are left empty: no source here renders them yet.
 */
const storyCaseArbitrary = (personKey: string): fc.Arbitrary<StoryCase> =>
  fc
    .record({
      person: personArbitrary(personKey),
      episodes: fc.uniqueArray(episodeInputsArbitrary, {
        minLength: 1,
        maxLength: 4,
        selector: ({ genericName }) => genericName,
      }),
      tailGap: fc.integer({ min: 0, max: 120 }),
    })
    .map(({ person, episodes, tailGap }) => {
      const laidOut = episodes.flatMap((episode, index) =>
        layOutEpisode(`${personKey}-drug${index + 1}`, episode)
      )
      const lastEventDay = Math.max(
        ...laidOut.flatMap(({ prescription }) => eventDaysOf(prescription))
      )
      const inStoryOrder = laidOut
        .map((each) => shifted(each, -1 - tailGap - lastEventDay))
        .toSorted((left, right) => left.prescription.written.day - right.prescription.written.day)
      return {
        story: {
          person,
          prescriptions: inStoryOrder.map(({ prescription }) => prescription),
          labDraws: [],
        },
        expected: inStoryOrder.map(expectedOf),
      }
    })
    .filter(
      ({ expected }) =>
        new Set(expected.map(({ writtenDay }) => writtenDay)).size === expected.length &&
        new Set(expected.map(({ lastFillDay }) => lastFillDay)).size === expected.length
    )

/** A Rexall Be Well account, created and last updated before the as-of day. */
const rexallAccountArbitrary: fc.Arbitrary<RexallAccount> = fc
  .record({
    uid: fc.uuid({ version: 4 }),
    reportingGuid: fc.uuid({ version: 4 }),
    store: fc.integer({ min: 1000, max: 9999 }),
    createdDay: fc.integer({ min: -3000, max: -2 }),
    updatedDraw: fc.nat({ max: 3000 }),
  })
  .map(({ uid, reportingGuid, store, createdDay, updatedDraw }) => ({
    uid,
    reportingGuid,
    storeId: String(store),
    pharmacyLocationId: `pharmacy-${store}`,
    createdDay,
    updatedDay: createdDay + (updatedDraw % -createdDay),
  }))

/** A generated Shoppers family account, and each managed person's story case in portal order. */
interface ShoppersCase {
  readonly account: ShoppersAccount
  readonly patients: readonly StoryCase[]
}

/** A ten-digit phone number in the `555-01xx` range reserved for fiction. */
const phoneNumberOf = (areaCode: number, line: number): string =>
  `${areaCode}55501${String(line % 100).padStart(2, '0')}`

/**
 * A Shoppers Drug Mart family account managing one to four people, the
 * holder listed first, each with a generated story; every prescription of
 * theirs filled at one store.
 */
const shoppersCaseArbitrary: fc.Arbitrary<ShoppersCase> = fc
  .integer({ min: 1, max: 4 })
  .chain((count) =>
    fc.record({
      pcid: fc.uuid({ version: 4 }),
      patientIds: fc.uniqueArray(fc.uuid({ version: 4 }), {
        minLength: count,
        maxLength: count,
      }),
      storyCases: fc.tuple(
        ...Array.from({ length: count }, (_, index) => storyCaseArbitrary(`person-${index + 1}`))
      ),
      areaCode: fc.constantFrom(416, 519, 613, 705, 905),
      phoneLines: fc.array(fc.nat({ max: 99 }), { minLength: count + 2, maxLength: count + 2 }),
      store: fc.integer({ min: 100, max: 9999 }),
      streetNumber: fc.integer({ min: 1, max: 999 }),
    })
  )
  .map(({ pcid, patientIds, storyCases, areaCode, phoneLines, store, streetNumber }) => {
    // The holder is listed first; `count` is at least one.
    const holder = storyCases[0].story.person
    return {
      patients: storyCases,
      account: {
        pcid,
        holder,
        phoneNumber: phoneNumberOf(areaCode, phoneLines[0] ?? 0),
        address: {
          line1: `${streetNumber} Main St`,
          city: 'Kingston',
          province: 'ON',
          postalCode: holder.postalCode,
        },
        store: {
          id: store,
          storeName: `Shoppers Drug Mart #${store}`,
          phoneNumber: phoneNumberOf(areaCode, phoneLines[1] ?? 0),
          address: {
            line1: `${streetNumber + 100} King St`,
            city: 'Kingston',
            province: 'ON',
            postalCode: 'K7L 1B3',
          },
        },
        patients: storyCases.map((storyCase, index) => ({
          patientId: patientIds[index] ?? pcid,
          phoneNumber: phoneNumberOf(areaCode, phoneLines[index + 2] ?? 0),
          story: storyCase.story,
        })),
      },
    }
  })

// ---------------------------------------------------------------------------
// Laboratories and lab draws
// ---------------------------------------------------------------------------

/*
 * Drawn from the LifeLabs print's alphabet so that a report laid out and read
 * back by the importer is the same report. A printable `Laboratory` keeps the
 * print's constraints: section names are distinct, and within a section only
 * the first group may be unnamed and group names are distinct.
 */

const ANALYTES = [
  'Sodium',
  'Potassium',
  'Chloride',
  'Glucose Random',
  'ALT',
  'Albumin',
  'Calcium',
  'Urea',
  'Iron',
  'Vitamin B12',
  'CRP',
  'Free T3',
  'PSA',
  'CK',
  'Magnesium',
  'Phosphate',
] as const
const LAB_SECTIONS = ['Hematology', 'Chemistry', 'Immunology', 'Endocrinology'] as const
const LAB_GROUPS = ['Differential', 'Electrolytes', 'Liver Function', 'Thyroid'] as const
const LAB_COMMENTS = ['Fasting specimen.', 'Repeat in 3 months.', 'Verified by repeat analysis.']
const LAB_UNITS = [null, 'mmol/L', 'µmol/L', 'g/L', 'µg/L', 'x E9/L', '%', 'mIU/L', 'U/L', 'hours']
const ORDERING_PRACTITIONERS = [
  'ROY DR. ANNE',
  'NGUYEN DR. LEE',
  'LAVOIE DR. PAT',
  'OSEI DR. KWAME',
]
const LAB_ADDRESSES = [
  ['1 Example Blvd.', 'Toronto, Ontario', 'Canada M0M 0M0'],
  ['2 Sample Way', 'Kingston, Ontario'],
] as const

/** A non-negative number with `decimals` places, as its printed text. */
const printedNumberArbitrary = (decimals: number): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 99_999 }).map((scaled) => (scaled / 10 ** decimals).toFixed(decimals))

const printedRangeArbitrary: fc.Arbitrary<PrintedRange> = fc
  .integer({ min: 0, max: 3 })
  .chain((decimals) =>
    fc.oneof(
      fc
        .tuple(printedNumberArbitrary(decimals), printedNumberArbitrary(decimals))
        .map(([one, other]): PrintedRange => {
          const [low = one, high = other] = [one, other].toSorted(
            (left, right) => Number(left) - Number(right)
          )
          return { _tag: 'between', low, high }
        }),
      printedNumberArbitrary(decimals).map((high): PrintedRange => ({ _tag: 'below', high })),
      printedNumberArbitrary(decimals).map((low): PrintedRange => ({ _tag: 'atLeast', low }))
    )
  )

/** One section's groups: an optional unnamed leading group, then distinct named ones. */
const groupNamesArbitrary: fc.Arbitrary<readonly string[]> = fc
  .tuple(fc.boolean(), fc.uniqueArray(fc.constantFrom(...LAB_GROUPS), { maxLength: 2 }))
  .map(([leadingUnnamed, named]) => (leadingUnnamed || named.length === 0 ? ['', ...named] : named))

/**
 * A laboratory printing up to about a dozen tests, each with its own story
 * name (`analyte-<n>`), under distinct sections.
 */
const laboratoryArbitrary: fc.Arbitrary<Laboratory> = fc
  .record({
    addressLines: fc.constantFrom(...LAB_ADDRESSES),
    licence: fc.constantFrom('#5687', '#5407'),
    headings: fc
      .uniqueArray(fc.constantFrom(...LAB_SECTIONS), { minLength: 1, maxLength: 3 })
      .chain((sections) =>
        fc.tuple(
          ...sections.map((section) =>
            groupNamesArbitrary.map((groups) => groups.map((group) => ({ section, group })))
          )
        )
      )
      .map((perSection) => perSection.flat()),
  })
  .chain(({ addressLines, licence, headings }) =>
    fc
      .tuple(
        ...headings.map((heading) =>
          fc
            .array(
              fc.record({
                name: fc.constantFrom(...ANALYTES),
                decimals: fc.integer({ min: 0, max: 3 }),
                male: printedRangeArbitrary,
                female: printedRangeArbitrary,
                comments: fc.subarray(LAB_COMMENTS, { maxLength: 2 }),
              }),
              { minLength: 1, maxLength: 3 }
            )
            .map((tests) => tests.map((test) => ({ ...heading, ...test })))
        )
      )
      .map((perHeading): Laboratory => ({
        addressLines,
        licence,
        tests: perHeading.flat().map((test, index): LifeLabsTest => ({
          storyTest: `analyte-${index}`,
          name: test.name,
          section: test.section,
          group: test.group,
          decimals: test.decimals,
          range: { male: test.male, female: test.female },
          comments: test.comments,
        })),
      }))
  )

/**
 * Draws on one to five distinct days before the as-of day, each on a distinct
 * subset of the laboratory's tests, every value printable at its test's
 * decimals.
 */
const labDrawsArbitrary = (laboratory: Laboratory): fc.Arbitrary<readonly LabDraw[]> =>
  fc
    .uniqueArray(fc.integer({ min: -1000, max: -1 }), { minLength: 1, maxLength: 5 })
    .chain((days) =>
      fc.tuple(
        ...days
          .toSorted((left, right) => left - right)
          .map((day) =>
            fc.subarray([...laboratory.tests], { minLength: 1 }).chain((tests) =>
              fc.tuple(
                ...tests.map((test) =>
                  fc
                    .record({
                      value: printedNumberArbitrary(test.decimals).map(Number),
                      unit: fc.constantFrom(...LAB_UNITS),
                    })
                    .map(({ value, unit }): LabDraw => ({ day, test: test.storyTest, value, unit }))
                )
              )
            )
          )
      )
    )
    .map((perDay) => perDay.flat())

/** A laboratory, and a person's story of lab draws it prints (no prescriptions). */
const labStoryArbitrary: fc.Arbitrary<{
  readonly laboratory: Laboratory
  readonly story: Story
}> = laboratoryArbitrary.chain((laboratory) =>
  fc
    .record({ person: personArbitrary('person-1'), labDraws: labDrawsArbitrary(laboratory) })
    .map(({ person, labDraws }) => ({ laboratory, story: { person, prescriptions: [], labDraws } }))
)

/** Ordered by one practitioner, copied to at most one other (the print joins a longer list). */
const requisitionArbitrary: fc.Arbitrary<LabRequisition> = fc.record({
  orderedBy: fc.constantFrom(...ORDERING_PRACTITIONERS),
  copyTo: fc.subarray(ORDERING_PRACTITIONERS, { maxLength: 1 }),
})

/** A Patient under one of the pharmacy source systems, keyed by a uuid. */
const sourcePatientArbitrary: fc.Arbitrary<SourcePatient> = fc.record({
  system: fc.constantFrom(
    'https://wildflowerhealth.io/fhir/sid/rexall-carebook',
    'https://wildflowerhealth.io/fhir/sid/shoppers-drugmart'
  ),
  originalId: fc.uuid(),
})

export {
  ageOn,
  asOfArbitrary,
  dinArbitrary,
  dosingArbitrary,
  expectedNameOf,
  expectedSigOf,
  labDrawsArbitrary,
  laboratoryArbitrary,
  labStoryArbitrary,
  personArbitrary,
  prescriberArbitrary,
  productArbitrary,
  requisitionArbitrary,
  rexallAccountArbitrary,
  shoppersCaseArbitrary,
  sourcePatientArbitrary,
  storyCaseArbitrary,
}
export type { ExpectedPrescription, ShoppersCase, StoryCase }
