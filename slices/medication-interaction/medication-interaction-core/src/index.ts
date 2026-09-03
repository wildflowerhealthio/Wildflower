/**
 * Drug-interaction checking against the DDInter database: decode the compact
 * bundled file into an {@link InteractionCatalog}, match a patient's
 * medications onto it, and report interactions in three groups (between the
 * patient's own drugs, with non-drugs, with common OTC actives).
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

export { type OtcDrug, otcDrugs } from './otc.ts'

export { type CatalogMatch, matchCatalogDrugs } from './match.ts'

export {
  findInteractions,
  type Interaction,
  type InteractionParty,
  type InteractionReport,
} from './group.ts'
