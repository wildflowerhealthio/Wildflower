import { decodeDdinterFile, type InteractionCatalog } from 'medication-interaction-core'

import ddinterData from './data/ddinter/ddinter.json'

let cached: InteractionCatalog | null = null

/**
 * The bundled DDInter interaction catalog, decoded on first call and cached
 * so the ~160k-pair decode only runs once the Interactions tab is actually
 * opened, not on every app load. `src/data/ddinter/ddinter.json` is
 * generated from DDInter's download CSVs by
 * `vp run -F medications-app data:ddinter -- <dir>` (see the README); an
 * empty file — nothing bundled yet — decodes to an empty catalog, which the
 * interactions view reports as such.
 */
const getInteractionCatalog = (): InteractionCatalog => {
  cached ??= decodeDdinterFile(ddinterData)
  return cached
}

export { getInteractionCatalog }
