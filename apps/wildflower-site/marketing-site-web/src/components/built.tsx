import type { JSX } from 'react'

import { APP_DESCRIPTIONS, onMarketingSite, sectionHref } from 'branding-core'

import { medicationsHomeImage } from '../assets/remote-images.ts'
import { AppRow } from './app-row.tsx'
import { Launcher } from './launcher.tsx'
import rows from './app-rows.module.css'
import layout from './layout.module.css'

/**
 * "Building on an open personal health record" — the patient-facing apps,
 * presented as things that exist rather than products being sold. The
 * Synthesized Health Viewer leads because it's the more evocative
 * "many-sources-on-one-chart" demo. Each row's copy is the shared
 * `APP_DESCRIPTIONS` entry the app's own landing page renders, and its
 * `Launcher` opens that landing page.
 */
function Built(): JSX.Element {
  const healthViewer = APP_DESCRIPTIONS.healthViewer
  const medications = APP_DESCRIPTIONS.medications
  const pebble = APP_DESCRIPTIONS.fhirSyncPebble
  const lifting = APP_DESCRIPTIONS.lifting

  return (
    <section className={layout['section']} id="built">
      <div className={layout['column']}>
        <h2 className={layout['section-title']}>
          What would you do if the data was all connected?
        </h2>
        <div className={`${layout['prose']} ${layout['prose--secondary']}`}>
          <p>
            I've collected my personal health record onto a FHIR server and started building the
            health apps I've really wanted with it.
          </p>
        </div>
        <div className={`${rows['rows']} ${rows['rows--after-intro']}`}>
          <AppRow
            title={healthViewer.name}
            status={healthViewer.status}
            paragraphs={healthViewer.paragraphs}
            placeholderLabel="screenshot — meds and labs timeline"
            launcher={
              <Launcher
                href={sectionHref(onMarketingSite, 'healthViewer')}
                label={healthViewer.launch.label}
                note={healthViewer.launch.note}
              />
            }
          />
          <AppRow
            title={medications.name}
            status={medications.status}
            paragraphs={medications.paragraphs}
            images={[medicationsHomeImage]}
            launcher={
              <Launcher
                href={sectionHref(onMarketingSite, 'medications')}
                label={medications.launch.label}
                note={medications.launch.note}
              />
            }
          />
          <AppRow
            title={pebble.name}
            status={pebble.status}
            paragraphs={pebble.paragraphs}
            placeholderLabel="photo — Pebble steps and sleep on a FHIR record"
            launcher={
              <Launcher
                href={sectionHref(onMarketingSite, 'fhirSyncPebble')}
                label={pebble.launch.label}
                note={pebble.launch.note}
              />
            }
          />
          <AppRow
            title={lifting.name}
            status={lifting.status}
            paragraphs={lifting.paragraphs}
            placeholderLabel="screenshot — today's workout, one set at a time"
            launcher={
              <Launcher
                href={sectionHref(onMarketingSite, 'lifting')}
                label={lifting.launch.label}
                note={lifting.launch.note}
              />
            }
          />
        </div>
      </div>
    </section>
  )
}

export { Built }
