import type { JSX } from 'react'

import { APP_DESCRIPTIONS, sectionRootPath } from 'branding-core'

import { wildflowerServerImages } from '../assets/remote-images.ts'
import { AppRow } from './app-row.tsx'
import { Launcher } from './launcher.tsx'
import rows from './app-rows.module.css'
import layout from './layout.module.css'

/**
 * "How do you get a personal health record?" — the awkward-but-real
 * workarounds that make the apps usable today, without cooperative
 * providers: a personal FHIR server first, then the on-device browser
 * scraper. The Importer's copy is the shared `APP_DESCRIPTIONS` entry its
 * own landing page renders; the row keeps its own title because here the
 * Importer is framed as infrastructure ("on-device scraping"), not by name.
 */
function PossibleToday(): JSX.Element {
  const importer = APP_DESCRIPTIONS.importer

  return (
    <section className={layout['section']} id="try">
      <div className={layout['column']}>
        <h2 className={layout['section-title']}>How do you get a personal health record?</h2>
        <div className={rows['rows']}>
          <AppRow
            title="Run your own on device FHIR server"
            paragraphs={[
              "I've taken an open-source FHIR server, added SMART authentication, and packaged " +
                'it into an app that runs on a phone or laptop.',
            ]}
            images={wildflowerServerImages}
            launcher={
              <Launcher
                href={sectionRootPath('serverDocs')}
                label="Read the Wildflower server docs"
                note="View the docs and available endpoints with tools to send requests to a live server"
              />
            }
          />
          <AppRow
            title="Use on-device scraping to pull in data"
            paragraphs={[
              'Building server-to-server integrations is hard, especially without permission. ' +
                'You can instead click around in your pharmacy, lab-result, or patient-record ' +
                'website in your own browser and save the data as the server sent it.',
              'The Importer, another SMART on FHIR app, then processes those results into ' +
                'FHIR-compatible records and saves them onto your server.',
            ]}
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
