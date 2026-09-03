import type { JSX } from 'react'

import { sectionRootPath } from 'branding-core'

import { AppRow } from './app-row.tsx'
import { Launcher } from './launcher.tsx'
import rows from './app-rows.module.css'
import layout from './layout.module.css'

/**
 * "Building on an open personal health record" — the two patient-facing
 * apps, presented as things that exist rather than products being sold. The
 * Synthesized Health Viewer intentionally has no launcher: there is no
 * public route for it yet (add one in the same pattern when a route
 * appears).
 */
function Built(): JSX.Element {
  return (
    <section className={layout['section']} id="built">
      <div className={layout['column']}>
        <h2 className={layout['section-title']}>Building on an open personal health record</h2>
        <div className={`${layout['prose']} ${layout['prose--secondary']}`}>
          <p>
            It's never made sense to me to declare one app my be-all-end-all personal health record.
            If I need to check something with a provider, I log into their website. That changes
            when you can use your complete record to actually do things.&nbsp;
            <br />
            <br />
            I've created a few apps that use SMART on FHIR to access my personal health record and
            imagine some of the possibilities when your "one place" is built on open standards.
          </p>
        </div>
        <div className={`${rows['rows']} ${rows['rows--after-intro']}`}>
          <AppRow
            title="Medication Viewer"
            status="Status: in use"
            placeholderLabel="screenshot — prescription list"
            launcher={
              <Launcher
                href={sectionRootPath('medications')}
                label="Open the Medication Viewer"
                note="View the medications for a patient on any FHIR server, including our demo"
              />
            }
          >
            My prescriptions are chaotic. My most reliable refill reminder is noticing a bottle is
            empty. This viewer shows all my prescriptions, arranged the way I need them: countdowns
            to refill day and alarming red text.
            <br />
            <br />
            Once you've got all of your medications in an app, other things become really easy, like
            checking for interactions or seeing if any drug companies have a program that'll give
            you a discount.
          </AppRow>
          <AppRow
            title="Synthesized Health Viewer"
            status="Status: demo, rough edges"
            placeholderLabel="screenshot — meds and labs timeline"
          >
            I'm on medications that require lab monitoring to make sure I've got a therapeutic dose,
            to watch for side effects, and to make sure my blood isn't poisoning me.&nbsp;
            <br />
            <br />
            This tool plots data from several sources on one chart, and an on-device AI model can
            answer questions. Because sometimes it's unclear how exactly my dose is affecting my
            levels, and if that new medication is having a meaningful effect on my liver enzymes.
          </AppRow>
        </div>
      </div>
    </section>
  )
}

export { Built }
