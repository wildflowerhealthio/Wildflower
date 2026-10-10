import type { Medication } from 'medication-core'

import {
  type CatalogDrug,
  ddinterDrugUrl,
  type InteractionCatalog,
  severityBetween,
} from './ddinter.ts'
import { addTallies, compareTallies, emptyTally, type SeverityTally, tallyOf } from './dots.ts'
import { matchCatalogDrugs } from './match.ts'
import { type OtcCategory, type OtcDrug, otcCategories } from './otc.ts'
import { compareSeverity, type Severity } from './severity.ts'

/** A patient medication together with every catalog drug its name resolved to (never empty). */
interface PatientMedication {
  readonly medication: Medication
  readonly drugs: readonly CatalogDrug[]
}

/**
 * One interaction as listed under a group: the patient medication on the
 * far side, the worst severity DDInter lists between the group's drugs and
 * the medication's, and the medication's drug on that worst pair.
 */
interface InteractionRow {
  readonly medication: Medication
  readonly severity: Severity
  /** The medication's drug on the pair carrying `severity`. */
  readonly drug: CatalogDrug
  /** DDInter page for `drug`, where the pair can be looked up. */
  readonly url: string
}

/** Rows plus their severity counts — the part every group shares. */
interface RowGroup {
  /** Sorted most-severe first, then by medication name. */
  readonly rows: readonly InteractionRow[]
  readonly tally: SeverityTally
}

/** A patient medication and the other patient medications it interacts with. */
interface MedicationGroup extends RowGroup, PatientMedication {}

/** A non-drug catalog entry (Ethanol, Caffeine, …) and the patient medications it interacts with. */
interface NonDrugGroup extends RowGroup {
  readonly drug: CatalogDrug
}

/** A curated OTC active and the patient medications it interacts with. */
interface OtcDrugGroup extends RowGroup {
  readonly entry: OtcDrug
  /** The catalog drugs `entry` resolved to (never empty). */
  readonly drugs: readonly CatalogDrug[]
}

/** An OTC category and the actives in it that interact with the patient's medications. */
interface OtcCategoryGroup {
  readonly category: OtcCategory
  /** Sorted in severity-count order, then by name; never empty. */
  readonly drugs: readonly OtcDrugGroup[]
  /** The sum over `drugs`. */
  readonly tally: SeverityTally
}

/**
 * The interactions report: three sections of groups, each group's rows being
 * the patient medications on the far side. Every list is sorted in
 * severity-count order (more Major first, then Moderate, Minor, Unknown), then
 * by name, and only non-empty groups are present.
 */
interface InteractionReport {
  /**
   * Each patient medication that interacts with another. A pair appears
   * twice, once under each medication, so a section-wide interaction count
   * is half the row total.
   */
  readonly medications: readonly MedicationGroup[]
  /** Non-drug catalog entries (food, alcohol, caffeine, …) the medications interact with. */
  readonly nonDrugs: readonly NonDrugGroup[]
  /** OTC categories with at least one active the medications interact with. */
  readonly otc: readonly OtcCategoryGroup[]
}

/** Alphabetical by DDInter name, so ordering is stable across inputs. */
const byName = (a: CatalogDrug, b: CatalogDrug): number => a.name.localeCompare(b.name)

const byMedication = (a: Medication, b: Medication): number =>
  a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)

const byRow = (x: InteractionRow, y: InteractionRow): number =>
  compareSeverity(x.severity, y.severity) || byMedication(x.medication, y.medication)

const byGroup = <G extends { readonly tally: SeverityTally }>(
  name: (group: G) => string
): ((a: G, b: G) => number) => {
  return (a, b) => compareTallies(a.tally, b.tally) || name(a).localeCompare(name(b))
}

/**
 * The worst pair DDInter lists between two drug sets: its severity and the
 * drug on `theirs` carrying it, or `null` when no pair is listed. Ties keep
 * the first of `theirs` (which callers pass sorted by name).
 */
const worstBetween = (
  catalog: InteractionCatalog,
  ours: readonly CatalogDrug[],
  theirs: readonly CatalogDrug[]
): { readonly severity: Severity; readonly drug: CatalogDrug } | null => {
  let worst: { readonly severity: Severity; readonly drug: CatalogDrug } | null = null
  for (const drug of theirs) {
    for (const own of ours) {
      const severity = severityBetween(catalog, own.index, drug.index)
      if (severity !== null && (worst === null || compareSeverity(severity, worst.severity) < 0)) {
        worst = { severity, drug }
      }
    }
  }
  return worst
}

/** The rows for `drugs` against every patient medication except `except`. */
const rowsAgainst = (
  catalog: InteractionCatalog,
  drugs: readonly CatalogDrug[],
  patients: readonly PatientMedication[],
  except: PatientMedication | null = null
): RowGroup => {
  const rows: InteractionRow[] = []
  for (const patient of patients) {
    if (patient === except) continue
    const worst = worstBetween(catalog, drugs, patient.drugs)
    if (worst !== null) {
      rows.push({
        medication: patient.medication,
        severity: worst.severity,
        drug: worst.drug,
        url: ddinterDrugUrl(worst.drug),
      })
    }
  }
  const sorted = rows.toSorted(byRow)
  return { rows: sorted, tally: tallyOf(sorted) }
}

/**
 * Check a patient's medications against the DDInter catalog and group the
 * interactions found.
 *
 * @param medications - The patient's medications (any status; the caller filters)
 * @param catalog - The decoded DDInter catalog
 * @param otc - The OTC categories to check against (defaults to {@link otcCategories})
 * @returns The three sections, every list in severity-count order then by name
 *
 * @remarks
 * A medication resolves to every catalog drug {@link matchCatalogDrugs} finds
 * for its name (none: left out). A row is the worst pair between two drug
 * sets, never one row per ingredient. The far side of a non-drug or OTC group
 * is never a patient drug, an OTC entry that is also a non-drug is reported
 * under `nonDrugs` only, and an earlier OTC entry keeps a drug a later one
 * would also claim. The grouping rules are spelled out in the slice's
 * `AGENTS.md`.
 */
const findInteractions = (
  medications: readonly Medication[],
  catalog: InteractionCatalog,
  otc: readonly OtcCategory[] = otcCategories
): InteractionReport => {
  const patients: PatientMedication[] = []
  for (const medication of medications) {
    const drugs = matchCatalogDrugs(medication.displayName, catalog)
      .map((match) => match.drug)
      .toSorted(byName)
    if (drugs.length > 0) patients.push({ medication, drugs })
  }
  const patientIndexes = new Set(patients.flatMap((patient) => patient.drugs.map((d) => d.index)))

  const medicationGroups: MedicationGroup[] = []
  for (const patient of patients) {
    const group = rowsAgainst(catalog, patient.drugs, patients, patient)
    if (group.rows.length > 0) medicationGroups.push({ ...patient, ...group })
  }

  const nonDrugs: NonDrugGroup[] = []
  for (const drug of catalog.drugs) {
    if (!drug.nonDrug || patientIndexes.has(drug.index)) continue
    const group = rowsAgainst(catalog, [drug], patients)
    if (group.rows.length > 0) nonDrugs.push({ drug, ...group })
  }

  const claimed = new Set<number>()
  const categories: OtcCategoryGroup[] = []
  for (const category of otc) {
    const drugGroups: OtcDrugGroup[] = []
    for (const entry of category.drugs) {
      const drugs: CatalogDrug[] = []
      for (const { drug } of matchCatalogDrugs(entry.name, catalog)) {
        if (drug.nonDrug || patientIndexes.has(drug.index) || claimed.has(drug.index)) continue
        claimed.add(drug.index)
        drugs.push(drug)
      }
      if (drugs.length === 0) continue
      const group = rowsAgainst(catalog, drugs.toSorted(byName), patients)
      if (group.rows.length > 0) drugGroups.push({ entry, drugs, ...group })
    }
    if (drugGroups.length === 0) continue
    categories.push({
      category,
      drugs: drugGroups.toSorted(byGroup((group) => group.entry.name)),
      tally: drugGroups.reduce((sum, group) => addTallies(sum, group.tally), emptyTally),
    })
  }

  return {
    medications: medicationGroups.toSorted(byGroup((group) => group.medication.displayName)),
    nonDrugs: nonDrugs.toSorted(byGroup((group) => group.drug.name)),
    otc: categories.toSorted(byGroup((group) => group.category.name)),
  }
}

export {
  findInteractions,
  type InteractionReport,
  type InteractionRow,
  type MedicationGroup,
  type NonDrugGroup,
  type OtcCategoryGroup,
  type OtcDrugGroup,
  type PatientMedication,
  type RowGroup,
}
