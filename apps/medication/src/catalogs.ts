import {
  decodeInnovicaresFile,
  decodeRxHelpFile,
  type SponsorCatalog,
} from 'medication-sponsorship-core'

import innovicaresData from './data/innovicares.json'
import rxhelpData from './data/rxhelp.json'

/**
 * The bundled sponsor catalogs, decoded once at module load. Listed
 * innoviCares-first so a medication matching both programs is grouped under
 * innoviCares (see `medication-sponsorship-core`'s grouping precedence).
 */
export const catalogs: readonly SponsorCatalog[] = [
  { sponsor: 'innovicares', drugs: decodeInnovicaresFile(innovicaresData) },
  { sponsor: 'rxhelp', drugs: decodeRxHelpFile(rxhelpData) },
]
