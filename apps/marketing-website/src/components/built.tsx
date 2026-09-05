import type { JSX } from 'react'

import { APP_DESCRIPTIONS, onMarketingSite, sectionHref } from 'branding-core'

import { medicationsHomeImage } from '../assets/remote-images.ts'
import { AppRow } from './app-row.tsx'
import { Launcher } from './launcher.tsx'
import rows from './app-rows.module.css'
import layout from './layout.module.css'

/**
 * "Building on an open personal health record" — the two patient-facing
 * apps, presented as things that exist rather than products being sold. The
 * Synthesized Health Viewer leads because it's the more evocative
 * "many-sources-on-one-chart" demo, even though it has no public route yet
 * (add a `Launcher` in the same pattern when a route appears). The
 * Medication Viewer's copy is the shared `APP_DESCRIPTIONS` entry its own
 * landing page renders.
 */
function Built(): JSX.Element {
  const medications = APP_DESCRIPTIONS.medications

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
            title="Synthesized Health Viewer"
            status="Status: demo, rough edges"
            paragraphs={[
              'I want to see health data from several places on one chart.',
              'I have a dose of a medication that keeps changing from my pharmacy, and labs ' +
                'tracking both the medication level and possible side effects. It is hard to tell ' +
                'what all the changes are doing to each other. This tool plots data from several ' +
                'sources on the same chart so I can see how everything relates.',
            ]}
            placeholderLabel="screenshot — meds and labs timeline"
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
        </div>
      </div>
    </section>
  )
}

export { Built }
