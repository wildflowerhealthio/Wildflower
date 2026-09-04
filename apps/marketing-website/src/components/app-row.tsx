import type { JSX, ReactNode } from 'react'

import styles from './app-row.module.css'
import layout from './layout.module.css'

/** A screenshot for an app row: an `<img>` source and its alt text. */
type AppRowImage = {
  readonly src: string
  readonly alt: string
}

/**
 * One app/infrastructure row: title, honest mono status line, body copy and
 * an optional launcher on the left; the screenshot slot on the right. Rows
 * that already have a real screenshot pass one (or several, laid out
 * side-by-side) through `images`; the rest fall back to a striped
 * placeholder with a mono label, which reads as intentionally unfinished
 * and suits the project.
 *
 * @param title - The `h3` row title.
 * @param status - The mono status line (omitted for infrastructure rows).
 * @param paragraphs - Body copy, one entry per paragraph, in reading order.
 * @param images - Real screenshot(s) to render in the slot. One image spans
 *   the slot; several sit side-by-side. Takes precedence over
 *   `placeholderLabel`.
 * @param placeholderLabel - Mono label inside the striped screenshot slot,
 *   shown when no `images` are provided.
 * @param launcher - An optional `<Launcher>` block after the body copy.
 * @param alignCenter - When true, the text column (labels + launcher) is
 *   vertically centered against the taller screenshot group.
 */
function AppRow({
  title,
  status,
  paragraphs,
  images,
  placeholderLabel,
  launcher,
  alignCenter = false,
}: {
  readonly title: ReactNode
  readonly status?: string
  readonly paragraphs: readonly string[]
  readonly images?: readonly AppRowImage[]
  readonly placeholderLabel?: string
  readonly launcher?: ReactNode
  readonly alignCenter?: boolean
}): JSX.Element {
  const rowClass = alignCenter
    ? `${styles['app-row']} ${styles['app-row--center']}`
    : styles['app-row']

  return (
    <article className={rowClass}>
      <div className={styles['app-row__text']}>
        <h3 className={styles['app-row__title']}>{title}</h3>
        {status === undefined ? null : <span className={layout['mono-note']}>{status}</span>}
        <div className={styles['app-row__body']}>
          {paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        {launcher}
      </div>
      {images === undefined || images.length === 0 ? (
        <div className={styles['app-row__slot']}>
          <span className={layout['mono-note']}>{placeholderLabel ?? ''}</span>
        </div>
      ) : (
        <div
          className={styles['app-row__figures']}
          data-count={images.length > 1 ? 'multi' : 'single'}
        >
          {images.map((image) => (
            <figure key={image.src} className={styles['app-row__figure']}>
              <img className={styles['app-row__image']} src={image.src} alt={image.alt} />
            </figure>
          ))}
        </div>
      )}
    </article>
  )
}

export { AppRow }
export type { AppRowImage }
