/**
 * Marketed Canadian drug products, each identified by a DIN verified against
 * Health Canada's Drug Product Database (DPD), and the catalogue the family's
 * stories prescribe from.
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

/**
 * The products the stories prescribe, every one verified against the DPD API
 * (`https://health-products.canada.ca/api/drug/drugproduct/?din=<DIN>&type=json`,
 * then `activeingredient`, `form` and `status` by `drug_code`) as **Marketed**,
 * with the ingredient, strength and form below.
 *
 * | DIN        | DPD drug code | Brand                     | Company                  | Active ingredient              | Form   |
 * | ---------- | ------------- | ------------------------- | ------------------------ | ------------------------------ | ------ |
 * | `02242685` | 66475         | TARO-WARFARIN             | Taro Pharmaceuticals Inc | warfarin sodium 5 mg           | Tablet |
 * | `02242684` | 66474         | TARO-WARFARIN             | Taro Pharmaceuticals Inc | warfarin sodium 4 mg           | Tablet |
 * | `02257726` | 74296         | TEVA-METFORMIN            | Teva Canada Limited      | metformin hydrochloride 500 mg | Tablet |
 * | `02246820` | 71020         | SANDOZ METFORMIN FC       | Sandoz Canada Inc        | metformin hydrochloride 500 mg | Tablet |
 * | `02274752` | 76022         | APO-CLARITHROMYCIN        | Apotex Inc               | clarithromycin 500 mg          | Tablet |
 *
 * @remarks
 * Metformin has no 1000 mg immediate-release tablet on the Canadian market, so
 * a 1000 mg dose is two 500 mg tablets, as a pharmacy would fill it.
 */
const catalogue = {
  taroWarfarin5mg: {
    din: '02242685',
    drugCode: 66475,
    brandName: 'Taro-Warfarin',
    genericName: 'Warfarin',
    strength: { value: 5, unit: 'mg' },
    form: 'tablet',
    company: 'Taro Pharmaceuticals Inc',
  },
  taroWarfarin4mg: {
    din: '02242684',
    drugCode: 66474,
    brandName: 'Taro-Warfarin',
    genericName: 'Warfarin',
    strength: { value: 4, unit: 'mg' },
    form: 'tablet',
    company: 'Taro Pharmaceuticals Inc',
  },
  tevaMetformin500mg: {
    din: '02257726',
    drugCode: 74296,
    brandName: 'Teva-Metformin',
    genericName: 'Metformin',
    strength: { value: 500, unit: 'mg' },
    form: 'tablet',
    company: 'Teva Canada Limited',
  },
  sandozMetformin500mg: {
    din: '02246820',
    drugCode: 71020,
    brandName: 'Sandoz Metformin FC',
    genericName: 'Metformin',
    strength: { value: 500, unit: 'mg' },
    form: 'tablet',
    company: 'Sandoz Canada Inc',
  },
  apoClarithromycin500mg: {
    din: '02274752',
    drugCode: 76022,
    brandName: 'Apo-Clarithromycin',
    genericName: 'Clarithromycin',
    strength: { value: 500, unit: 'mg' },
    form: 'tablet',
    company: 'Apotex Inc',
  },
} as const satisfies Record<string, DrugProduct>

export { catalogue, labelOf, strengthLabelOf }
export type { DrugProduct, Strength }
