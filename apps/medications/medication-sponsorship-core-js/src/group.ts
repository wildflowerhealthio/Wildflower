import { type DrugMatch, matchMedication } from './match.ts'
import type { Province } from './province.ts'
import {
  coversProvince,
  type Medication,
  type SponsoredDrug,
  type SponsorProgram,
} from './sponsor.ts'

/** A medication paired with the sponsored-drug match that placed it. */
interface GroupedMedication {
  readonly medication: Medication
  readonly match: DrugMatch
}

/** One sponsor program's bucket of matched medications. */
interface SponsorGroup {
  readonly sponsor: SponsorProgram
  readonly items: readonly GroupedMedication[]
}

/** The full grouping result. */
interface GroupedMedications {
  /** One group per sponsor program, in catalog (precedence) order. */
  readonly sponsored: readonly SponsorGroup[]
  /** Medications matched by no sponsor covering the selected province. */
  readonly unsponsored: readonly Medication[]
}

/** A sponsor program plus its drug list. */
interface SponsorCatalog {
  readonly sponsor: SponsorProgram
  readonly drugs: readonly SponsoredDrug[]
}

interface GroupOptions {
  /** The province whose coverage decides which drugs are eligible. */
  readonly province: Province
  /**
   * Sponsor catalogs, checked in array order. When a medication matches drugs
   * in more than one catalog it is placed in the first — so list innoviCares
   * ahead of RxHelp for innoviCares-first grouping.
   */
  readonly catalogs: readonly SponsorCatalog[]
}

/**
 * Group medications by the first sponsor program (in `catalogs` order) whose
 * province-covered drug list matches them; everything else falls into
 * `unsponsored`. Empty catalogs still produce an (empty) sponsor group so the
 * UI can render a stable set of sections.
 */
const groupMedications = (
  medications: readonly Medication[],
  options: GroupOptions
): GroupedMedications => {
  const covering = options.catalogs.map((catalog) => ({
    sponsor: catalog.sponsor,
    drugs: catalog.drugs.filter((drug) => coversProvince(drug, options.province)),
    items: [] as GroupedMedication[],
  }))
  const unsponsored: Medication[] = []

  for (const medication of medications) {
    let matched = false
    for (const catalog of covering) {
      const match = matchMedication(medication, catalog.drugs)
      if (match !== null) {
        catalog.items.push({ medication, match })
        matched = true
        break
      }
    }
    if (!matched) unsponsored.push(medication)
  }

  return {
    sponsored: covering.map((catalog) => ({ sponsor: catalog.sponsor, items: catalog.items })),
    unsponsored,
  }
}

export {
  groupMedications,
  type GroupedMedication,
  type SponsorGroup,
  type GroupedMedications,
  type SponsorCatalog,
  type GroupOptions,
}
