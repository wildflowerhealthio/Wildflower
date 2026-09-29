import type * as DrugProduct from './drug-product.ts'
import type { StoryDay } from './story-day.ts'

/**
 * A prescription as a pharmacy holds it: one product, one dosing, a fill
 * quantity and supply, repeats, and the days it was filled — plus why it was
 * written and, when it no longer runs, why it ended.
 *
 * @remarks
 * A medication episode is the prescriptions for one drug read in order: a dose
 * change, a hold, a generic switch or a renewal ends one prescription (or
 * lets it run out) and writes the next. Everything a pharmacy source renders —
 * the sig, the quantity, the repeats still available, the status on the as-of
 * day — is derived from these fields, so a renderer never restates the story.
 */

/** Doses per day, as the sig spells them. */
type DosesPerDay = 1 | 2

/** How the prescription is taken. */
interface Dosing {
  /** Tablets per dose. */
  readonly tabletsPerDose: 1 | 2
  readonly dosesPerDay: DosesPerDay
  /** Words the sig ends with (`'WITH MEALS'`), or `null` for none. */
  readonly direction: string | null
}

/** The prescriber, as a pharmacy record names them. */
interface Prescriber {
  /** Stable handle the prescriber's ids are hashed from. */
  readonly key: string
  /** The name as the pharmacy prints it (`'DR A SMITH'`). */
  readonly display: string
}

/**
 * Why a prescription was written: the first of its drug (`start`), a new dose
 * (`dose-change`), more repeats at the same dose (`renewal`), the same drug
 * again after a hold (`resume`), or the same dose on another manufacturer's
 * product (`generic-switch`).
 */
type WrittenReason = 'start' | 'dose-change' | 'renewal' | 'resume' | 'generic-switch'

/**
 * Why a prescription stopped before running out: replaced by a new dose
 * (`dose-change`), held on a prescriber's instruction (`hold`), replaced by
 * another manufacturer's product (`generic-switch`), or discontinued (`stop`).
 */
type EndReason = 'dose-change' | 'hold' | 'generic-switch' | 'stop'

/** A prescription's status on the as-of day, in FHIR's `MedicationRequest.status` vocabulary. */
type Status = 'active' | 'completed' | 'stopped'

/** See the module summary. */
interface Prescription {
  /** Unique within a story (`'warfarin-2'`); every rendered id is hashed from it. */
  readonly key: string
  readonly product: DrugProduct.DrugProduct
  readonly dosing: Dosing
  /** Days one fill lasts. */
  readonly supplyDaysPerFill: number
  /** Refills authorized after the first fill. */
  readonly repeatsAllowed: number
  readonly prescriber: Prescriber
  readonly written: { readonly day: StoryDay; readonly reason: WrittenReason }
  /** When and why it stopped early, or `null` while it runs (or ran out). */
  readonly ended: { readonly day: StoryDay; readonly reason: EndReason } | null
  /** The days it was filled, ascending; the first is the original fill, the rest repeats. */
  readonly fillDays: readonly StoryDay[]
}

const SIG_FREQUENCY: Readonly<Record<DosesPerDay, string>> = {
  1: 'ONCE DAILY',
  2: 'TWICE DAILY',
}

/**
 * Fill days on a refill cadence: the first fill, then each refill one supply
 * after the one before it plus however many days late it was.
 *
 * @param firstFillDay - The original fill
 * @param supplyDaysPerFill - Days one fill lasts
 * @param refillDaysLate - One entry per refill: days past its due date it was
 *   picked up (`0` on time)
 * @returns `1 + refillDaysLate.length` ascending days
 */
const fillDaysOnCadence = (
  firstFillDay: StoryDay,
  supplyDaysPerFill: number,
  refillDaysLate: readonly number[]
): readonly StoryDay[] =>
  refillDaysLate.reduce<readonly StoryDay[]>(
    (fillDays, daysLate) => [
      ...fillDays,
      (fillDays.at(-1) ?? firstFillDay) + supplyDaysPerFill + daysLate,
    ],
    [firstFillDay]
  )

/** Tablets taken each day. */
const tabletsPerDayOf = (dosing: Dosing): number => dosing.tabletsPerDose * dosing.dosesPerDay

/** Tablets dispensed per fill: the dosing's daily tablets over the fill's supply. */
const quantityPerFillOf = (prescription: Prescription): number =>
  tabletsPerDayOf(prescription.dosing) * prescription.supplyDaysPerFill

/** The dose taken each day, in the product's strength unit. */
const dailyDoseOf = (prescription: Prescription): DrugProduct.Strength => ({
  value: tabletsPerDayOf(prescription.dosing) * prescription.product.strength.value,
  unit: prescription.product.strength.unit,
})

/**
 * The directions as a pharmacy label prints them:
 * `'TAKE 2 TABLETS (=1000MG) BY MOUTH TWICE DAILY WITH MEALS'`.
 */
const sigOf = ({ dosing, product }: Prescription): string => {
  const tablets = `${dosing.tabletsPerDose} TABLET${dosing.tabletsPerDose === 1 ? '' : 'S'}`
  const perDose = `${dosing.tabletsPerDose * product.strength.value}${product.strength.unit.toUpperCase()}`
  const direction = dosing.direction === null ? '' : ` ${dosing.direction}`
  return `TAKE ${tablets} (=${perDose}) BY MOUTH ${SIG_FREQUENCY[dosing.dosesPerDay]}${direction}`
}

/** Refills still available: those authorized less those used after the first fill. */
const repeatsRemainingOf = (prescription: Prescription): number =>
  prescription.repeatsAllowed - Math.max(0, prescription.fillDays.length - 1)

/** The day the last fill's supply runs out, or `null` for a prescription never filled. */
const suppliedUntilOf = (prescription: Prescription): StoryDay | null => {
  const lastFillDay = prescription.fillDays.at(-1)
  return lastFillDay === undefined ? null : lastFillDay + prescription.supplyDaysPerFill
}

/**
 * The status on the as-of day: `stopped` once it has ended; otherwise `active`
 * while it has repeats left, or its last fill still has supply on the as-of
 * day; `completed` once both have run out.
 */
const statusOf = (prescription: Prescription): Status => {
  if (prescription.ended !== null) return 'stopped'
  const suppliedUntil = suppliedUntilOf(prescription)
  const hasSupplyLeft = suppliedUntil === null || suppliedUntil > 0
  return repeatsRemainingOf(prescription) > 0 || hasSupplyLeft ? 'active' : 'completed'
}

export {
  dailyDoseOf,
  fillDaysOnCadence,
  quantityPerFillOf,
  repeatsRemainingOf,
  sigOf,
  statusOf,
  suppliedUntilOf,
}
export type { Dosing, DosesPerDay, EndReason, Prescriber, Prescription, Status, WrittenReason }
