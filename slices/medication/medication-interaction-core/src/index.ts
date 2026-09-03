/**
 * Drug-interaction checking against the DDInter database: decode the compact
 * bundled file into an {@link InteractionCatalog}, match a patient's
 * medications onto it, and report interactions as three sections of groups
 * (each of the patient's medications, each non-drug, each OTC category and
 * active) with the severity tallies the UI paints as pips.
 *
 * @packageDocumentation
 */
export {
  compareSeverity,
  parseSeverity,
  Severity,
  SeverityCode,
  severityCodes,
  severityFromCode,
  severityLabels,
  severityRank,
  severityToCode,
} from './severity.ts'

export {
  type CatalogDrug,
  DDINTER_HOME_URL,
  ddinterDrugUrl,
  DdinterFile,
  DdinterSource,
  decodeDdinterFile,
  type InteractionCatalog,
  isNonDrugName,
  pairKey,
  severityBetween,
} from './ddinter.ts'

export {
  buildDdinterFile,
  type DdinterCsvRow,
  ddinterCsvColumns,
  parseCsv,
  parseDdinterCsv,
} from './ddinter-csv.ts'

export { nonDrugNames } from './non-drug.ts'

export { type OtcCategory, otcCategories, type OtcDrug } from './otc.ts'

export {
  addTallies,
  compareTallies,
  emptyTally,
  type SeverityTally,
  tallyOf,
  tallyTotal,
  worstSeverity,
} from './dots.ts'

export { type CatalogMatch, matchCatalogDrugs } from './match.ts'

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
} from './group.ts'
