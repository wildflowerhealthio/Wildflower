import type { FrequentSubstring } from 'pdf-anonymizer-core'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './pdf-anonymize-panel.module.css'

interface SuggestionsProps {
  readonly suggestions: readonly FrequentSubstring[]
  readonly onAdd: (text: string) => void
  readonly className?: string
}

const Suggestions = ({ suggestions, onAdd, className }: SuggestionsProps): JSX.Element | null => {
  if (suggestions.length === 0) return null

  return (
    <div className={cn(styles['suggestions'], className)}>
      <h3 className={cn(styles['suggestions__title'], 'text-label-3')}>Suggestions</h3>
      <p className={cn(styles['suggestions__description'], 'text-body-3')}>
        Frequently occurring text — click to add as a rule.
      </p>
      <div className={styles['suggestions__list']} role="list" aria-label="Suggested substrings">
        {suggestions.map((s) => (
          <button
            key={s.text}
            type="button"
            role="listitem"
            className={styles['suggestions__chip']}
            onClick={() => onAdd(s.text)}
          >
            {s.text}
            <span className={styles['suggestions__chip-count']}>{s.count}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export { Suggestions, type SuggestionsProps }
