import type { JSX, ReactNode } from 'react'

import styles from './asks.module.css'
import layout from './layout.module.css'

/**
 * "How to make these standards, standard" — the three policy/platform asks.
 * This is the page's argument, not a features list; external links open in
 * the same tab, matching the rest of the site.
 */
function Asks(): JSX.Element {
  return (
    <section className={layout['section']} id="asks">
      <div className={layout['column']}>
        <h2 className={layout['section-title']}>How do we make these standards, standard?</h2>
        <div className={`${layout['prose']} ${layout['prose--secondary']}`}>
          <p>
            I don't expect most people to run a FHIR server. These tools should be legislated and
            built into our devices. Using SMART and FHIR now helps push them toward being the
            default interoperability standard for developers and legislators.
          </p>
        </div>
        <div className={styles['asks']}>
          <Ask
            title={
              <a href="https://www.parl.ca/legisinfo/en/bill/45-1/s-5">
                Connected Care for Canadians Act
              </a>
            }
          >
            <p className={styles['ask__body']}>The Act, currently in reading, will require:</p>
            <blockquote className={styles['ask__quote']}>
              <i>
                "A health information technology vendor must ensure that the health information
                technology that they license, sell or supply as a service is interoperable."
              </i>
            </blockquote>
            <p className={styles['ask__body']}>
              No specific interoperability standard is listed in the Act, but the Governor in
              Council is able to specify further regulation within the act. I would urge that the
              first definitions of interoperability work in terms of SMART and FHIR
            </p>
          </Ask>
          <Ask
            title={
              <a href="https://news.ontario.ca/en/release/1007191/ontario-creating-new-provincewide-primary-care-medical-record-system">
                Ontario's Primary Care Medical Record
              </a>
            }
          >
            <p className={styles['ask__body']}>
              Ontario is collecting proposals for a records system that will provide clinicians with
              a complete view of a patient&rsquo;s health history. The same procurement should
              require patient-facing SMART on FHIR access, instead of producing another silo.
            </p>
          </Ask>
          <Ask
            title={
              <>
                <a href="https://developer.apple.com/documentation/healthkit/accessing-health-records">
                  Apple
                </a>{' '}
                and{' '}
                <a href="https://developer.android.com/health-and-fitness/health-connect/medical-records">
                  Google
                </a>
              </>
            }
          >
            <p className={styles['ask__body']}>
              Health and Health Connect offer&nbsp;<i>some</i> FHIR resource storage, but this
              should expand to&nbsp;every resource type. Also, the built-in Health apps should
              expose a full SMART on FHIR server, so health apps for patients can build to the
              standard.
            </p>
          </Ask>
        </div>
      </div>
    </section>
  )
}

/** One ask: a linked `h3` and its body blocks. */
function Ask({
  title,
  children,
}: {
  readonly title: ReactNode
  readonly children: ReactNode
}): JSX.Element {
  return (
    <div className={styles['ask']}>
      <h3 className={layout['block-title']}>{title}</h3>
      {children}
    </div>
  )
}

export { Asks }
