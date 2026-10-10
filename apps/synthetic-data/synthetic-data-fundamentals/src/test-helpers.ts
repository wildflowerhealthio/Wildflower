import { AdministrativeGender } from '@wildflowerhealthio/fhir-r4/data-types'
/**
 * fast-check arbitraries for the story model: as-of instants, people, drug
 * products, prescriptions and whole stories, shared with every generator
 * package's tests through the `synthetic-data-fundamentals/test-helpers`
 * subpath. Each story comes paired with what a pharmacy record of it must say,
 * worked out here from the generated inputs rather than by the model's own
 * functions, so a round-trip test compares an importer's output against an
 * independent reckoning.
 *
 * @packageDocumentation
 */
import { DateTime } from 'effect'
import * as fc from 'fast-check'

import type * as DrugProduct from './story/drug-product.ts'
import type * as Person from './story/person.ts'
import type * as Prescription from './story/prescription.ts'
import type { StoryDay } from './story/story-day.ts'
import type { Story } from './story/story.ts'

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
      gender: fc.constantFrom(...Object.values(AdministrativeGender.enums)),
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

const productOf = (
  genericName: string,
  strength: DrugProduct.Strength,
  manufacturer: Manufacturer,
  din: string,
  drugCode: number
): DrugProduct.DrugProduct => ({
  din,
  drugCode,
  brandName: `${manufacturer.prefix}-${genericName}`,
  genericName,
  strength,
  form: 'tablet',
  company: manufacturer.company,
})

/** Any tablet, of any strength, by any manufacturer. */
const productArbitrary: fc.Arbitrary<DrugProduct.DrugProduct> = fc
  .record({
    genericName: genericNameArbitrary,
    strength: strengthArbitrary,
    manufacturer: fc.constantFrom(...MANUFACTURERS),
    din: dinArbitrary,
    drugCode: fc.integer({ min: 1, max: 199_999 }),
  })
  .map(({ genericName, strength, manufacturer, din, drugCode }) =>
    productOf(genericName, strength, manufacturer, din, drugCode)
  )

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

const dosingArbitrary: fc.Arbitrary<Prescription.Dosing> = fc.record({
  tabletsPerDose: fc.constantFrom(1 as const, 2 as const),
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

/** The sig, written out: `'TAKE 2 TABLETS (=40MG) BY MOUTH TWICE DAILY WITH MEALS'`. */
const expectedSigOf = (dosing: Prescription.Dosing, strength: DrugProduct.Strength): string =>
  [
    'TAKE',
    dosing.tabletsPerDose === 1 ? '1 TABLET' : `${dosing.tabletsPerDose} TABLETS`,
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
  readonly din: string
  /** The key of the prescription for the same drug this one follows, or `null` for the first. */
  readonly previousKey: string | null
  /** The key of the prescription for the same drug that follows this one, or `null` for the last. */
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
  readonly drugCode: number
  readonly prescriber: Prescription.Prescriber
}

/** At most this many refills: {@link StepInputs.refillDaysLate} has one entry per refill. */
const MAX_REPEATS = 5

const stepInputsArbitrary: fc.Arbitrary<StepInputs> = fc.record({
  dosing: dosingArbitrary,
  supplyDays: fc.constantFrom(7, 14, 28, 30, 60, 90),
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
  drugCode: fc.integer({ min: 1, max: 199_999 }),
  prescriber: prescriberArbitrary,
})

/** One drug's prescriptions: why each after the first was written, and their inputs. */
interface EpisodeInputs {
  readonly genericName: string
  readonly strength: DrugProduct.Strength
  readonly manufacturer: Manufacturer
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
  /** The episode's prescription before this one, or `null` for its first. */
  readonly previousKey: string | null
  /** The episode's prescription after this one, or `null` for its last. */
  readonly nextKey: string | null
}

/** A DIN for a new product that is never the one it replaces. */
const newDinOf = (din: string, replaced: DrugProduct.DrugProduct): string =>
  din === replaced.din ? `${din.slice(0, 7)}${(Number(din.slice(7)) + 1) % 10}` : din

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
      step.drugCode
    )
  }
  if (reason === 'generic-switch') {
    const others = MANUFACTURERS.filter(({ company }) => company !== previous.company)
    const maker = others[step.pick % others.length] ?? sameMaker
    if (maker !== undefined) {
      return productOf(
        previous.genericName,
        previous.strength,
        maker,
        newDinOf(step.din, previous),
        step.drugCode
      )
    }
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
    first.drugCode
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
    laidOut.push({
      refills,
      previousKey: index === 0 ? null : `${episodeKey}-${index}`,
      nextKey: nextReason === undefined ? null : `${episodeKey}-${index + 2}`,
      prescription: {
        key: `${episodeKey}-${index + 1}`,
        product,
        dosing,
        supplyDaysPerFill: step.supplyDays,
        repeatsAllowed: step.repeatsAllowed,
        prescriber: step.prescriber,
        written: { day: writtenDay, reason },
        ended,
        fillDays,
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
  const { product, dosing, supplyDaysPerFill, repeatsAllowed } = prescription
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
    name: expectedNameOf(product),
    din: product.din,
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
 * prescription is filled at least once, and no two are written on the same
 * day, so a test can find a record by its written date. Each drug has its own
 * generic name, so a drug's prescriptions are exactly one episode. Lab draws
 * are left empty; a lab source's tests generate their own.
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
        new Set(expected.map(({ writtenDay }) => writtenDay)).size === expected.length
    )

export {
  ageOn,
  asOfArbitrary,
  dosingArbitrary,
  expectedSigOf,
  personArbitrary,
  productArbitrary,
  storyCaseArbitrary,
}
export type { ExpectedPrescription, StoryCase }
