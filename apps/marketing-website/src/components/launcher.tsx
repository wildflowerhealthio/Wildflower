import type { JSX } from 'react'

import styles from './launcher.module.css'
import layout from './layout.module.css'

/**
 * The page's only call-to-action shape: a bold text link with a literal `→`
 * (not an icon) over one quiet mono line telling the reader they can try the
 * app against a demo server. Deliberately not a button — an earlier design
 * had filled buttons and they were removed for being too startup-like.
 *
 * @param href - The app route the link opens.
 * @param label - Link text; the trailing arrow is added here.
 * @param note - The quiet mono demo/live-server note under the link.
 */
function Launcher({
  href,
  label,
  note,
}: {
  readonly href: string
  readonly label: string
  readonly note: string
}): JSX.Element {
  return (
    <div className={styles['launcher']}>
      <a className={styles['launcher__link']} href={href}>
        {label} &rarr;
      </a>
      <span className={layout['mono-note']}>{note}</span>
    </div>
  )
}

export { Launcher }
