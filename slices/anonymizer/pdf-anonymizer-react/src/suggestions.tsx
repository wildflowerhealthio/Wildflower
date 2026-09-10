import type { FrequentSubstring } from 'pdf-anonymizer-core'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './pdf-anonymize-panel.module.css'

interface SuggestionsProps {
  readonly suggestions: readonly FrequentSubstring[]
  readonly onAdd: (text: string) => void
  readonly onDismiss: (text: string) => void
  readonly className?: string
}

const Suggestions = ({
  suggestions,
  onAdd,
  onDismiss,
  className,
}: SuggestionsProps): JSX.Element | null => {
  if (suggestions.length === 0) return null

  return (
    <div className={cn(styles['suggestions'], className)}>
      <h3 className={cn(styles['suggestions__title'], 'text-label-3')}>Suggestions</h3>
      <p className={cn(styles['suggestions__description'], 'text-body-3')}>
        Frequently occurring text — anonymize or dismiss to make room for more.
      </p>
      <div className={styles['suggestions__list']} role="list" aria-label="Suggested substrings">
        {suggestions.map((s) => (
          <span key={s.text} role="listitem" className={styles['suggestions__chip']}>
            <span className={styles['suggestions__chip-text']}>{s.text}</span>
            <span className={styles['suggestions__chip-count']}>{s.count}</span>
            <span className={styles['suggestions__chip-actions']}>
              <button
                type="button"
                className={styles['suggestions__chip-action']}
                onClick={() => onAdd(s.text)}
                aria-label={`Anonymize "${s.text}"`}
                title="Anonymize"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM3.5 8a4.5 4.5 0 0 1 4-4.47v3.22L5.15 9.1A4.48 4.48 0 0 1 3.5 8Zm2.65 2.1L8 8.25l1.85 1.85a4.48 4.48 0 0 1-3.7 0Zm4.7-1L8.5 6.75V3.53A4.5 4.5 0 0 1 12.5 8c0 .76-.19 1.47-.52 2.1Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
              <button
                type="button"
                className={styles['suggestions__chip-action']}
                onClick={() => onDismiss(s.text)}
                aria-label={`Dismiss "${s.text}"`}
                title="Dismiss"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M4.47 3.53a.75.75 0 0 0-1.06 1.06L6.94 8l-3.53 3.41a.75.75 0 1 0 1.06 1.06L8 9.06l3.47 3.41a.75.75 0 0 0 1.06-1.06L9.06 8l3.47-3.41a.75.75 0 0 0-1.06-1.06L8 6.94 4.47 3.53Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

export { Suggestions, type SuggestionsProps }
