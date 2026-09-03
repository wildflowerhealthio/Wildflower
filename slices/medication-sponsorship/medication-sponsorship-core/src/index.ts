export {
  allProvinces,
  isProvince,
  parseProvinceList,
  Province,
  provinceCodes,
  provinceNames,
} from './province.ts'

export { coversProvince, SponsoredDrug, SponsorProgram, sponsorProgramLabels } from './sponsor.ts'

// The matcher fundamentals live in `medication-matching-core`; re-exported so
// this package's public surface is unchanged for its consumers.
export {
  dedupeMedicationsByName,
  type MatchConfidence,
  type Medication,
  normalizeName,
  tokenize,
} from 'medication-matching-core'

export { type DrugMatch, matchDrug, type MatchField, matchMedication } from './match.ts'

export {
  groupMedications,
  type GroupedMedication,
  type GroupedMedications,
  type GroupOptions,
  type SponsorCatalog,
  type SponsorGroup,
} from './group.ts'

export {
  decodeInnovicaresFile,
  InnovicaresFile,
  InnovicaresRaw,
  innovicaresToDrug,
} from './innovicares.ts'

export { decodeRxHelpFile, RxHelpFile, RxHelpRaw, rxhelpToDrug } from './rxhelp.ts'
