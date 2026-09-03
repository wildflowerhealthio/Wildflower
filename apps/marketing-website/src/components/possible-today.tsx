import type { JSX } from 'react'

import { APP_DESCRIPTIONS, sectionRootPath } from 'branding-core'

import { AppRow } from './app-row.tsx'
import { Launcher } from './launcher.tsx'
import rows from './app-rows.module.css'
import layout from './layout.module.css'

/**
 * "How I make this all possible today" — the two pieces of infrastructure
 * that make the apps usable without cooperative providers: the personal FHIR
 * server first, the Importer second (that order is deliberate). The
 * Importer's copy is the shared `APP_DESCRIPTIONS` entry its own landing
 * page renders; the row keeps its own title because here the Importer is
 * presented as infrastructure, not by name.
 */
function PossibleToday(): JSX.Element {
  const importer = APP_DESCRIPTIONS.importer

  return (
    <section className={layout['section']} id="try">
      <div className={layout['column']}>
        <h2 className={layout['section-title']}>How I make this all possible today</h2>
        <div className={rows['rows']}>
          <AppRow
            title={<>A personal SMART compatible&nbsp;FHIR&nbsp;server</>}
            paragraphs={[
              "Providers rarely offer open, interoperable storage — so I've packaged open-source FHIR servers into an app that runs on a phone or laptop.",
            ]}
            placeholderLabel="screenshot — Wildflower server"
            launcher={
              <Launcher
                href={sectionRootPath('serverDocs')}
                label="Read the Wildflower server docs"
                note="View the docs and available endpoints with tools to send requests to a live server"
              />
            }
          />
          <AppRow
            title="Import what the browser sees directly"
            paragraphs={importer.paragraphs}
            placeholderLabel="screenshot — Importer"
            launcher={
              <Launcher
                href={sectionRootPath('importer')}
                label={importer.launch.label}
                note={importer.launch.note}
              />
            }
          />
        </div>
      </div>
    </section>
  )
}

export { PossibleToday }
