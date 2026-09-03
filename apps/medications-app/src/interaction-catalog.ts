import { decodeDdinterFile, type InteractionCatalog } from 'medication-interaction-core'

import ddinterData from './data/ddinter/ddinter.json'

/**
 * The bundled DDInter interaction catalog, decoded once at module load.
 * `src/data/ddinter/ddinter.json` is generated from DDInter's download CSVs
 * by `vp run -F medications-app data:ddinter -- <dir>` (see the README); an
 * empty file — nothing bundled yet — decodes to an empty catalog, which the
 * interactions view reports as such.
 */
export const interactionCatalog: InteractionCatalog = decodeDdinterFile(ddinterData)
