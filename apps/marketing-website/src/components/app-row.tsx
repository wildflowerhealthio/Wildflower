import type { JSX, ReactNode } from 'react'

import styles from './app-row.module.css'
import layout from './layout.module.css'

/**
 * One app/infrastructure row: title, honest mono status line, body copy and
 * an optional launcher on the left; the screenshot slot on the right. Until
 * real screenshots exist the slot is a striped placeholder with a mono label —
 * that reads as intentionally unfinished, which suits the project.
 *
 * @param title - The `h3` row title.
 * @param status - The mono status line (omitted for infrastructure rows).
 * @param placeholderLabel - Mono label inside the striped screenshot slot.
 * @param launcher - An optional `<Launcher>` block after the body copy.
 * @param children - Body copy paragraph content.
 */
function AppRow({
  title,
  status,
  placeholderLabel,
  launcher,
  children,
}: {
  readonly title: ReactNode
  readonly status?: string
  readonly placeholderLabel: string
  readonly launcher?: ReactNode
  readonly children: ReactNode
}): JSX.Element {
  return (
    <article className={styles['app-row']}>
      <div className={styles['app-row__text']}>
        <h3 className={styles['app-row__title']}>{title}</h3>
        {status === undefined ? null : <span className={layout['mono-note']}>{status}</span>}
        <p className={styles['app-row__body']}>{children}</p>
        {launcher}
      </div>
      <div className={styles['app-row__slot']}>
        <span className={layout['mono-note']}>{placeholderLabel}</span>
      </div>
    </article>
  )
}

export { AppRow }
