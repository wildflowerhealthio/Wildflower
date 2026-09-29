/**
 * A marketed Canadian drug product as a story prescribes it, identified by its
 * DIN.
 *
 * @remarks
 * This package carries the type only. The products a data set prescribes, and
 * their verification against Health Canada's Drug Product Database (DPD) — or,
 * for a natural health product, the Licensed Natural Health Products Database
 * (LNHPD) — live with the stories in `wildflowerhealthio/synthetic-data`.
 */

/** A strength per dispensed unit, as the pharmacy prints it (`5 mg`). */
interface Strength {
  readonly value: number
  readonly unit: 'mg' | 'mcg'
}

/**
 * What every marketed product carries, whichever database verifies it.
 *
 * @remarks
 * `brandName`, `company` and the ingredient's strength are what the verifying
 * database prints for that DIN. `genericName` is the name a pharmacy label
 * leads with, and the one the interaction and sponsorship matchers see.
 */
interface MarketedProduct {
  /** Drug Identification Number: eight digits, leading zeros kept. */
  readonly din: string
  /** The brand name, in title case (`Taro-Warfarin`). */
  readonly brandName: string
  /** The generic name a label leads with (`Warfarin`). */
  readonly genericName: string
  /** Strength of the single active ingredient per tablet. */
  readonly strength: Strength
  readonly form: 'tablet'
  /** The company name, in title case. */
  readonly company: string
}

/** A drug the DPD lists: `din` and `drugCode` are its own keys. */
interface DpdProduct extends MarketedProduct {
  /** The DPD's internal product key (its API's `drug_code`), for re-verification. */
  readonly drugCode: number
  readonly lnhpdId?: never
}

/**
 * A natural health product that kept its old DIN as its licence number (a
 * "Transitional DIN"): dispensed under that number like any DIN, but the DPD
 * no longer lists it, so it has no `drugCode` and is verified against the
 * Licensed Natural Health Products Database (LNHPD) by `lnhpdId`.
 */
interface NaturalHealthProduct extends MarketedProduct {
  readonly drugCode: null
  /** The LNHPD's product key (its API's `lnhpd_id`), for re-verification. */
  readonly lnhpdId: number
}

/** One marketed product: listed in the DPD, or licensed as a natural health product. */
type DrugProduct = DpdProduct | NaturalHealthProduct

/** A strength as the pharmacy writes it: `'5 mg'`. */
const strengthLabelOf = (product: DrugProduct): string =>
  `${product.strength.value} ${product.strength.unit}`

/** The label a pharmacy list leads with: `'Warfarin 5 mg tablet'`. */
const labelOf = (product: DrugProduct): string =>
  `${product.genericName} ${strengthLabelOf(product)} ${product.form}`

export { labelOf, strengthLabelOf }
export type { DpdProduct, DrugProduct, MarketedProduct, NaturalHealthProduct, Strength }
