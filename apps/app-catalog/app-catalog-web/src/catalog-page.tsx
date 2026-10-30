import { CATALOG_JSON_PATH } from '@wildflowerhealthio/app-catalog-core-js/location'
import { SiteFooter, SiteHeader, fromApp } from '@wildflowerhealthio/branding-react'
import type { JSX } from 'react'

import styles from './catalog-page.module.css'

/**
 * The catalog's page: the shared site header and footer around a pointer to
 * the catalog file.
 *
 * @param catalogJsonPath - The catalog's `.json` copy, site-absolute.
 */
function CatalogPage({ catalogJsonPath }: { readonly catalogJsonPath: string }): JSX.Element {
  return (
    <div className={styles['catalog-page']}>
      <SiteHeader nav={fromApp} />
      <main className={styles['catalog-page__main']}>
        <h1 className={styles['catalog-page__title']}>Wildflower App Catalog</h1>
        <p>
          The SMART on FHIR apps worth trying with a Wildflower server, published as a HALO App
          Catalog: <a href={catalogJsonPath}>{CATALOG_JSON_PATH}</a>.
        </p>
      </main>
      <SiteFooter />
    </div>
  )
}

export { CatalogPage }
