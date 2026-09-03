import { decodeDdinterFile, type InteractionCatalog } from 'medication-interaction-core'

import ddinterUrl from './data/ddinter/ddinter.json?url'

let cached: InteractionCatalog | null = null

/**
 * Fetch and decode the bundled DDInter interaction catalog, caching the result
 * so the ~160k-pair decode runs only once.
 *
 * @remarks
 * The data is imported as a URL (`?url`) and fetched on demand rather than
 * imported as JSON: a JSON import inlines the file into the app chunk as a
 * ~160k-element JS array literal, which overflows JavaScriptCore's compiler on
 * iOS (`RangeError: Maximum call stack size exceeded`) while the module is
 * evaluated — before any app code runs. As a fetched asset it is a plain string
 * parsed by the native, iterative `Response.json()`, and it also stays out of
 * the initial bundle, downloaded only when the Interactions tab is first opened.
 *
 * `src/data/ddinter/ddinter.json` is generated from DDInter's download CSVs by
 * `vp run -F medications-app data:ddinter -- <dir>` (see the README); an empty
 * file — nothing bundled yet — decodes to an empty catalog, which the
 * interactions view reports as such.
 */
const getInteractionCatalog = async (): Promise<InteractionCatalog> => {
  if (cached === null) {
    const response = await fetch(ddinterUrl)
    if (!response.ok) {
      throw new Error(
        `Could not load the interaction database (${response.status} ${response.statusText})`
      )
    }
    cached = decodeDdinterFile(await response.json())
  }
  return cached
}

export { getInteractionCatalog }
