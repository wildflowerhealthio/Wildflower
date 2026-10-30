/**
 * Where Wildflower's App Catalog sits under its origin: the paths the catalog
 * file is published at. Plain strings with no imports, so a page, a build step
 * or a CI script can name the catalog's files without loading `AppCatalog`'s
 * schema.
 *
 * `import { CATALOG_PATH } from '@wildflowerhealthio/app-catalog-core-js/location'`
 */

/** The catalog's path under its origin, as HALO names it. */
const CATALOG_PATH = 'apps'

/**
 * The same catalog under a `.json` name, which GitHub Pages serves as
 * `application/json`; it serves the extensionless {@link CATALOG_PATH} as
 * `application/octet-stream`.
 */
const CATALOG_JSON_PATH = 'apps.json'

export { CATALOG_JSON_PATH, CATALOG_PATH }
