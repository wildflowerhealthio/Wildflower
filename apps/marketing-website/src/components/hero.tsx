import { useEffect, useRef, type JSX } from 'react'

import { portraitImage } from '../assets/remote-images.ts'
import { countUpStats } from '../count-up.ts'
import styles from './hero.module.css'
import layout from './layout.module.css'

/** One row of the "complex-care patient" stats grid, in display order. */
type StatRow = {
  readonly value: number
  /** Renders the value as "N+" ("10+ prescription medications"). */
  readonly plus?: boolean
  readonly label: string
}

const STAT_ROWS: readonly StatRow[] = [
  { value: 4, label: 'long-term conditions' },
  { value: 10, plus: true, label: 'prescription medications' },
  { value: 213, label: 'lab results' },
  { value: 18, label: 'vaccinations' },
  { value: 1, label: 'X-ray' },
  { value: 3, label: 'hospital visits' },
  { value: 4, label: 'clinics' },
  { value: 10, plus: true, label: 'providers in my circle of care' },
]

/**
 * The opening: who the author is, the portrait dissolving into the page
 * background, the animated stats grid establishing the scale of one patient's
 * record, and the four-beat closing story ending on the JPEG line.
 *
 * The stats grid's number cells each end in an invisible "+" unless the value
 * renders one for real — that reserves the plus sign's width so all digits
 * right-align against the "10+" rows. The count-up reads its targets back out
 * of the rendered cells (see `count-up.ts`).
 */
function Hero(): JSX.Element {
  const statsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (statsRef.current) countUpStats(statsRef.current)
  }, [])

  return (
    <section className={styles['hero']} id="top">
      <div className={`${layout['column']} ${styles['hero__grid']}`}>
        <div className={styles['hero__lockup']}>
          <h2 className={styles['hero__title']}>Hi, I'm Ruth.</h2>
          <p className={styles['hero__tier']}>
            I've been writing software for patients and thinking about how health systems share data
            for seven years.
          </p>
        </div>
        <figure className={styles['hero__photo']}>
          <img src={portraitImage.src} alt={portraitImage.alt} />
        </figure>
        <div className={styles['hero__body']}>
          <p className={styles['hero__lead-in']}>I'm also a complex-care patient with:</p>
          <div className={styles['hero__stats']} ref={statsRef}>
            {STAT_ROWS.map((row) => (
              <StatCells key={row.label} row={row} />
            ))}
          </div>
        </div>
      </div>
      <div className={layout['column']}>
        <div className={styles['hero__story']}>
          <p className={styles['hero__tier']}>
            I've worked at three different companies that wanted to be{' '}
            <i>"the place for all your health needs"</i>.{' '} Right now, there are eight websites I
            can log into for details about my health.{' '}
            <br />
            <br />
            I can record my vaccination history in five of them.
            <br />
            <br />I <i>built</i> the vaccination history tool in one of them.
            <br />
            My vaccination history is a JPEG attached to an email from my mom, because why would I
            bother typing it in somewhere.
          </p>
        </div>
      </div>
    </section>
  )
}

/**
 * One stats row: a mono number cell and a label cell, direct siblings in the
 * grid (the count-up expects the container's children to alternate
 * number/label). Non-plus values carry the hidden "+" width-reserver;
 * `visibility: hidden` keeps it out of the accessibility tree.
 */
function StatCells({ row }: { readonly row: StatRow }): JSX.Element {
  return (
    <>
      <span className={styles['hero__stat-number']}>
        {row.plus === true ? `${row.value}+` : row.value}
        {row.plus === true ? null : <span className={styles['hero__stat-plus-pad']}>+</span>}
      </span>
      <span className={styles['hero__stat-label']}>{row.label}</span>
    </>
  )
}

export { Hero }
