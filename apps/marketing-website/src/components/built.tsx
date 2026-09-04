import type { JSX } from 'react'

import { APP_DESCRIPTIONS, sectionRootPath } from 'branding-core'

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
        <h2 className={layout['section-title']}>Building on an open personal health record</h2>
        <div className={`${layout['prose']} ${layout['prose--secondary']}`}>
          <p>
            I've built a few apps that use SMART on FHIR to reach a server carrying my combined
            personal health record — some because I wanted them for myself, and some to imagine what
            becomes possible once your "one place" is built on open standards.
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
            image={medicationsHomeImage}
            launcher={
              <Launcher
                href={sectionRootPath('medications')}
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
