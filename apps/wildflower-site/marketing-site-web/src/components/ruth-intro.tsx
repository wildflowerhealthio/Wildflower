import { useEffect, useRef, type JSX } from 'react'

import { countUpStats } from '../count-up.ts'
import layout from './layout.module.css'
import styles from './ruth-intro.module.css'

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
 * The introduction under the hero: bio prose on the left, the animated
 * stats grid on the right at the same row, establishing the scale of one
 * patient's record. The stats grid is hidden on narrow screens — it does
 * not survive a single-column stack, and the bio carries the story
 * on its own there.
 *
 * The stats grid's number cells each end in an invisible "+" unless the
 * value renders one for real — that reserves the plus sign's width so all
 * digits right-align against the "10+" rows. The count-up reads its targets
 * back out of the rendered cells (see `count-up.ts`).
 */
function RuthIntro(): JSX.Element {
  const statsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (statsRef.current) countUpStats(statsRef.current)
  }, [])

  return (
    <section className={layout['section']}>
      <div className={`${layout['column']} ${styles['ruth']}`}>
        <h2 className={`${layout['section-title']} ${styles['ruth__title']}`}>
          I'm a health-tech developer and a complex-care patient
        </h2>
        <div className={`${layout['prose']} ${styles['ruth__bio']}`}>
          <p>
            Over the last seven years I've written software for practice management, virtual
            healthcare, remote monitoring, and imaging sharing.
          </p>
          <p>
            All of those tools had a handful of integrations that made each of them a little more
            useful — a few islands of connected services, but no real information sharing that
            reaches me as a patient. My pharmacies, diagnostic labs, and doctors can't even let me
            export a spreadsheet.
          </p>
          <p>
            A real "one place" would store data from everywhere and let you reach it with whatever
            apps you like. There are tools and apps that haven't been imagined yet, because of how
            spread out the data is.
          </p>
        </div>
        <aside
          className={styles['ruth__stats-block']}
          aria-label="My personal tally of health data"
        >
          <p className={styles['ruth__stats-title']}>My personal tally of health data</p>
          <div className={styles['ruth__stats']} ref={statsRef}>
            {STAT_ROWS.map((row) => (
              <StatCells key={row.label} row={row} />
            ))}
          </div>
        </aside>
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
      <span className={styles['ruth__stat-number']}>
        {row.plus === true ? `${row.value}+` : row.value}
        {row.plus === true ? null : <span className={styles['ruth__stat-plus-pad']}>+</span>}
      </span>
      <span className={styles['ruth__stat-label']}>{row.label}</span>
    </>
  )
}

export { RuthIntro }
