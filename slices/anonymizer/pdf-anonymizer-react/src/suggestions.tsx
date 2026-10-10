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
                    d="M2.22 2.22a.75.75 0 0 1 1.06 0l10.5 10.5a.75.75 0 0 1-1.06 1.06l-1.95-1.95A7.47 7.47 0 0 1 8 12.5c-3.5 0-6.17-2.33-7.13-3.75a1.26 1.26 0 0 1 0-1.5A9.73 9.73 0 0 1 3.78 4.84L2.22 3.28a.75.75 0 0 1 0-1.06ZM5.4 6.46A3 3 0 0 0 9.54 10.6L8.5 9.56a1.5 1.5 0 0 1-2.06-2.06L5.4 6.46Zm5.62 3.5 1.56 1.56A9.73 9.73 0 0 0 15.13 8.75a1.26 1.26 0 0 0 0-1.5C14.17 5.83 11.5 3.5 8 3.5c-.89 0-1.74.15-2.53.42l1.6 1.6A3 3 0 0 1 11.02 9.96Z"
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
                    d="M8 3.5c3.5 0 6.17 2.33 7.13 3.75a1.26 1.26 0 0 1 0 1.5C14.17 10.17 11.5 12.5 8 12.5S1.83 10.17.87 8.75a1.26 1.26 0 0 1 0-1.5C1.83 5.83 4.5 3.5 8 3.5ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
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
