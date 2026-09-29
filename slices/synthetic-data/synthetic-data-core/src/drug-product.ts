/**
 * A marketed Canadian drug product as a story prescribes it, identified by its
 * DIN.
 *
 * @remarks
 * This package carries the type only. The products a data set prescribes, and
 * their verification against Health Canada's Drug Product Database (DPD), live
 * with the stories in `wildflowerhealthio/synthetic-data`.
 */

/** A strength per dispensed unit, as the pharmacy prints it (`5 mg`). */
interface Strength {
  readonly value: number
  readonly unit: 'mg' | 'mcg'
}

/**
 * One marketed product as the DPD lists it.
 *
 * @remarks
 * `din` and `drugCode` are the DPD's own keys; `brandName`, `company` and the
 * ingredient's strength are what the DPD prints for that DIN. `genericName` is
 * the name a pharmacy label leads with, and the one the interaction and
 * sponsorship matchers see.
 */
interface DrugProduct {
  /** Drug Identification Number: eight digits, leading zeros kept. */
  readonly din: string
  /** The DPD's internal product key (its API's `drug_code`), for re-verification. */
  readonly drugCode: number
  /** The DPD brand name, in title case (`Taro-Warfarin`). */
  readonly brandName: string
  /** The generic name a label leads with (`Warfarin`). */
  readonly genericName: string
  /** Strength of the single active ingredient per tablet. */
  readonly strength: Strength
  readonly form: 'tablet'
  /** The DPD's company name, in title case. */
  readonly company: string
}

/** A strength as the pharmacy writes it: `'5 mg'`. */
const strengthLabelOf = (product: DrugProduct): string =>
  `${product.strength.value} ${product.strength.unit}`

/** The label a pharmacy list leads with: `'Warfarin 5 mg tablet'`. */
const labelOf = (product: DrugProduct): string =>
  `${product.genericName} ${strengthLabelOf(product)} ${product.form}`

export { labelOf, strengthLabelOf }
export type { DrugProduct, Strength }
