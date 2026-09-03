import type { Medication } from 'medication-matching-core'

import {
  type CatalogDrug,
  ddinterDrugUrl,
  type InteractionCatalog,
  severityBetween,
} from './ddinter.ts'
import { matchCatalogDrugs } from './match.ts'
import { type OtcDrug, otcDrugs } from './otc.ts'
import { compareSeverity, type Severity } from './severity.ts'

/** One side of an interaction: the catalog drug, plus the patient medication it came from (if any). */
interface InteractionParty {
  readonly drug: CatalogDrug
  /** The patient's medication that matched `drug`; `null` for the OTC / non-drug side. */
  readonly medication: Medication | null
  /** The OTC list entry `drug` came from, when this is the OTC side. */
  readonly otc: OtcDrug | null
}

/** One interacting pair with DDInter's severity and a link to read more. */
interface Interaction {
  readonly a: InteractionParty
  readonly b: InteractionParty
  readonly severity: Severity
  /** DDInter page for `a`'s drug, where the pair can be looked up. */
  readonly url: string
}

/** The three groups the UI shows. Each is sorted most-severe first, then by name. */
interface InteractionReport {
  /** Pairs among the patient's own medications (each unordered pair once). */
  readonly knownDrugs: readonly Interaction[]
  /** Patient medication × non-drug entry (food, alcohol, caffeine, …). */
  readonly nonDrugs: readonly Interaction[]
  /** Patient medication × curated OTC active. */
  readonly otc: readonly Interaction[]
}

/** Alphabetical by DDInter name, so ordering is stable across inputs. */
const byName = (a: CatalogDrug, b: CatalogDrug): number => a.name.localeCompare(b.name)

/** Most-severe first, then by the two drug names. */
const byRow = (x: Interaction, y: Interaction): number =>
  compareSeverity(x.severity, y.severity) ||
  byName(x.a.drug, y.a.drug) ||
  byName(x.b.drug, y.b.drug)

const patientParty = (drug: CatalogDrug, medication: Medication): InteractionParty => ({
  drug,
  medication,
  otc: null,
})

const row = (a: InteractionParty, b: InteractionParty, severity: Severity): Interaction => ({
  a,
  b,
  severity,
  url: ddinterDrugUrl(a.drug),
})

/**
 * Check a patient's medications against the DDInter catalog and group the
 * interactions found.
 *
 * @param medications - The patient's medications (any status; the caller filters)
 * @param catalog - The decoded DDInter catalog
 * @param otc - The OTC actives to check against (defaults to {@link otcDrugs})
 * @returns The three groups, each sorted most-severe first then by name
 *
 * @remarks
 * Each medication resolves to zero or more catalog drugs via
 * {@link matchCatalogDrugs}; a drug two medications both resolve to is
 * counted once (the first medication in input order is the one reported).
 * `knownDrugs` holds every unordered pair of distinct patient drugs DDInter
 * lists, so it is independent of medication order and never repeats a pair.
 * The other two groups pair each patient drug with catalog entries that are
 * _not_ themselves patient drugs — a pair already in `knownDrugs` is not
 * repeated under OTC or non-drugs — and an OTC entry that is also a non-drug
 * (nicotine) is reported under non-drugs only.
 */
const findInteractions = (
  medications: readonly Medication[],
  catalog: InteractionCatalog,
  otc: readonly OtcDrug[] = otcDrugs
): InteractionReport => {
  // Patient drugs, keyed by catalog index; first medication to match wins.
  const patient = new Map<number, InteractionParty>()
  for (const medication of medications) {
    for (const match of matchCatalogDrugs(medication.displayName, catalog)) {
      if (!patient.has(match.drug.index)) {
        patient.set(match.drug.index, patientParty(match.drug, medication))
      }
    }
  }
  const patientDrugs = [...patient.values()].toSorted((x, y) => byName(x.drug, y.drug))

  const knownDrugs: Interaction[] = []
  for (const [i, a] of patientDrugs.entries()) {
    for (const b of patientDrugs.slice(i + 1)) {
      const severity = severityBetween(catalog, a.drug.index, b.drug.index)
      if (severity !== null) knownDrugs.push(row(a, b, severity))
    }
  }

  const nonDrugs: Interaction[] = []
  for (const drug of catalog.drugs) {
    if (!drug.nonDrug || patient.has(drug.index)) continue
    const other: InteractionParty = { drug, medication: null, otc: null }
    for (const a of patientDrugs) {
      const severity = severityBetween(catalog, a.drug.index, drug.index)
      if (severity !== null) nonDrugs.push(row(a, other, severity))
    }
  }

  // OTC entries resolved to catalog drugs, first list entry to claim a drug wins.
  const otcParties = new Map<number, InteractionParty>()
  for (const entry of otc) {
    for (const match of matchCatalogDrugs(entry.name, catalog)) {
      const { drug } = match
      if (drug.nonDrug || patient.has(drug.index) || otcParties.has(drug.index)) continue
      otcParties.set(drug.index, { drug, medication: null, otc: entry })
    }
  }
  const otcRows: Interaction[] = []
  for (const other of otcParties.values()) {
    for (const a of patientDrugs) {
      const severity = severityBetween(catalog, a.drug.index, other.drug.index)
      if (severity !== null) otcRows.push(row(a, other, severity))
    }
  }

  return {
    knownDrugs: knownDrugs.toSorted(byRow),
    nonDrugs: nonDrugs.toSorted(byRow),
    otc: otcRows.toSorted(byRow),
  }
}

export { findInteractions, type Interaction, type InteractionParty, type InteractionReport }
