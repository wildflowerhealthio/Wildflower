import type { JSX } from 'react'

import { sectionRootPath } from 'branding-core'

import { AppRow } from './app-row.tsx'
import { Launcher } from './launcher.tsx'
import rows from './app-rows.module.css'
import layout from './layout.module.css'

/**
 * "How I make this all possible today" — the two pieces of infrastructure
 * that make the apps usable without cooperative providers: the personal FHIR
 * server first, the Importer second (that order is deliberate).
 */
function PossibleToday(): JSX.Element {
  return (
    <section className={layout['section']} id="try">
      <div className={layout['column']}>
        <h2 className={layout['section-title']}>How I make this all possible today</h2>
        <div className={rows['rows']}>
          <AppRow
            title={<>A personal SMART compatible&nbsp;FHIR&nbsp;server</>}
            placeholderLabel="screenshot — Wildflower server"
            launcher={
              <Launcher
                href={sectionRootPath('serverDocs')}
                label="Read the Wildflower server docs"
                note="View the docs and available endpoints with tools to send requests to a live server"
              />
            }
          >
            Providers rarely offer open, interoperable storage — so I've packaged open-source FHIR
            servers into an app that runs on a phone or laptop.
          </AppRow>
          <AppRow
            title="Import what the browser sees directly"
            placeholderLabel="screenshot — Importer"
            launcher={
              <Launcher
                href={sectionRootPath('importer')}
                label="Open the Importer"
                note="Import to any FHIR server, including a demo one"
              />
            }
          >
            You can use your own browser, click around in your pharmacy / lab result / patient
            record's website and save everything their server sent. The Importer can then process
            those results to produce FHIR compatible records, and save them on your server.
          </AppRow>
        </div>
      </div>
    </section>
  )
}

export { PossibleToday }
