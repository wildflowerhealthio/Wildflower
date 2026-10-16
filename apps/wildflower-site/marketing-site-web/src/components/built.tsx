import type { JSX } from 'react'

import { APP_DESCRIPTIONS, sectionUrl } from '@wildflowerhealthio/branding-core'

import { medicationsHomeImage } from '../assets/remote-images.ts'
import { AppRow } from './app-row.tsx'
import { Launcher } from './launcher.tsx'
import rows from './app-rows.module.css'
import layout from './layout.module.css'

/**
 * "Building on an open personal health record" — the patient-facing apps,
 * presented as things that exist rather than products being sold. Plots
 * leads because it's the more evocative
 * "many-sources-on-one-chart" demo. Each row's copy is the shared
 * `APP_DESCRIPTIONS` entry the app's own landing page renders, and its
 * `Launcher` opens that landing page.
 */
function Built(): JSX.Element {
  const plots = APP_DESCRIPTIONS.plots
  const medications = APP_DESCRIPTIONS.medications
  const pebble = APP_DESCRIPTIONS.fhirSyncPebble
  const strength = APP_DESCRIPTIONS.strength

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
            title={plots.name}
            status={plots.status}
            paragraphs={plots.paragraphs}
            placeholderLabel="screenshot — meds and labs timeline"
            launcher={
              <Launcher
                href={sectionUrl('plots')}
                label={plots.launch.label}
                note={plots.launch.note}
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
                href={sectionUrl('medications')}
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
                href={sectionUrl('fhirSyncPebble')}
                label={pebble.launch.label}
                note={pebble.launch.note}
              />
            }
          />
          <AppRow
            title={strength.name}
            status={strength.status}
            paragraphs={strength.paragraphs}
            placeholderLabel="screenshot — today's workout, one set at a time"
            launcher={
              <Launcher
                href={sectionUrl('strength')}
                label={strength.launch.label}
                note={strength.launch.note}
              />
            }
          />
        </div>
      </div>
    </section>
  )
}

export { Built }
