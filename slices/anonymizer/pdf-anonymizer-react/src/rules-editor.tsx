import type { RuleMatch } from 'pdf-anonymizer-core'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge, TextField } from 'react-tundraish'

import styles from './pdf-anonymize-panel.module.css'

interface RulesEditorProps {
  readonly rules: readonly { readonly id: string; readonly text: string }[]
  readonly ruleMatches: readonly RuleMatch[]
  readonly onRuleChange: (id: string, text: string) => void
  readonly onAddRule: () => void
  readonly onRemoveRule: (id: string) => void
}

const matchCountFor = (ruleId: string, matches: readonly RuleMatch[]): number | undefined =>
  matches.find((m) => m.ruleId === ruleId)?.count

const RulesEditor = ({
  rules,
  ruleMatches,
  onRuleChange,
  onAddRule,
  onRemoveRule,
}: RulesEditorProps): JSX.Element => (
  <div className={styles['rules']}>
    <h3 className={cn(styles['rules__title'], 'text-label-3')}>Substitution rules</h3>
    <p className={cn(styles['rules__description'], 'text-body-3')}>
      Enter text to mask — case-insensitive literal matching. Each match is replaced with a
      class-preserving mask (letters → X/x, digits → 0).
    </p>

    {rules.map((rule) => {
      const count = matchCountFor(rule.id, ruleMatches)
      return (
        <div key={rule.id} className={styles['rules__row']}>
          <div className={styles['rules__field']}>
            <TextField
              label="Text to mask"
              value={rule.text}
              onChange={(value) => onRuleChange(rule.id, value)}
            />
          </div>
          <div className={styles['rules__meta']}>
            {rule.text !== '' && count !== undefined ? (
              <span className="text-body-3">
                {count === 0 ? (
                  <StatusBadge tone="warning">0 matches</StatusBadge>
                ) : (
                  `${count} ${count === 1 ? 'match' : 'matches'}`
                )}
              </span>
            ) : null}
            {rules.length > 1 ? (
              <button
                type="button"
                className={cn(styles['rules__remove'], 'button-2')}
                onClick={() => onRemoveRule(rule.id)}
                aria-label={`Remove rule ${rule.text || '(empty)'}`}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      )
    })}

    <button type="button" className="button-2" onClick={onAddRule}>
      Add rule
    </button>
  </div>
)

export { RulesEditor, type RulesEditorProps }
