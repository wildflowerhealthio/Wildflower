import {
  applySubstitutions,
  extractFrequentSubstrings,
  type SubstitutionRule,
} from 'pdf-anonymizer-core'
import type { Document } from 'positioned-text'
import { useCallback, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import { anonymizedJsonFileName, downloadBlob, positionedTextBlob } from './download-json.ts'
import { RulesEditor } from './rules-editor.tsx'
import { RunsView } from './runs-view.tsx'
import { Suggestions } from './suggestions.tsx'
import styles from './pdf-anonymize-panel.module.css'

interface PdfAnonymizePanelProps {
  readonly value: Document.Type
  readonly fileName: string
  readonly className?: string
}

let nextRuleId = 0
const freshId = (): string => `rule-${++nextRuleId}`

const MAX_DISPLAYED_SUGGESTIONS = 20

const PdfAnonymizePanel = ({ value, fileName, className }: PdfAnonymizePanelProps): JSX.Element => {
  const [rules, setRules] = useState<SubstitutionRule[]>(() => [{ id: freshId(), text: '' }])
  const [dismissedSuggestions, setDismissedSuggestions] = useState<ReadonlySet<string>>(
    () => new Set()
  )

  const { document: anonymized, ruleMatches } = useMemo(
    () => applySubstitutions(value, rules),
    [value, rules]
  )

  const totalRuns = useMemo(() => value.pages.reduce((sum, p) => sum + p.runs.length, 0), [value])
  const totalMatches = ruleMatches.reduce((sum, m) => sum + m.count, 0)

  const onRuleChange = useCallback((id: string, text: string) => {
    setRules((current) => current.map((r) => (r.id === id ? { ...r, text } : r)))
  }, [])

  const onAddRule = useCallback(() => {
    setRules((current) => [...current, { id: freshId(), text: '' }])
  }, [])

  const onRemoveRule = useCallback((id: string) => {
    setRules((current) => current.filter((r) => r.id !== id))
  }, [])

  const download = useCallback(() => {
    const blob = positionedTextBlob(anonymized)
    downloadBlob(blob, anonymizedJsonFileName(fileName))
  }, [anonymized, fileName])

  const activeRules = rules.filter((r) => r.text !== '')

  const allSuggestions = useMemo(() => extractFrequentSubstrings(value), [value])

  const filteredSuggestions = useMemo(() => {
    const ruleTexts = new Set(rules.map((r) => r.text.toLowerCase()).filter((t) => t !== ''))
    return allSuggestions
      .filter(
        (s) =>
          !ruleTexts.has(s.text.toLowerCase()) && !dismissedSuggestions.has(s.text.toLowerCase())
      )
      .slice(0, MAX_DISPLAYED_SUGGESTIONS)
  }, [allSuggestions, rules, dismissedSuggestions])

  const onAddSuggestion = useCallback((text: string) => {
    setRules((current) => [...current, { id: freshId(), text }])
  }, [])

  const onDismissSuggestion = useCallback((text: string) => {
    setDismissedSuggestions((current) => new Set([...current, text.toLowerCase()]))
  }, [])

  const onRunClick = useCallback((text: string) => {
    setRules((current) => [...current, { id: freshId(), text }])
  }, [])

  return (
    <section className={cn(styles['panel'], className)} aria-label="Anonymize PDF">
      <section aria-label="What this document contains">
        <h3 className={cn(styles['panel__section-title'], 'text-label-3')}>
          What this document contains
        </h3>
        <ul className={cn(styles['panel__manifest'], 'text-body-3')}>
          <li>
            <strong>{value.pages.length === 1 ? '1 page' : `${value.pages.length} pages`}</strong>
            {' of extracted text.'}
          </li>
          <li>
            {totalRuns === 1 ? '1 positioned text run.' : `${totalRuns} positioned text runs.`}
          </li>
        </ul>

        <h3 className={cn(styles['panel__section-title'], 'text-label-3')}>
          What this does not contain
        </h3>
        <ul className={cn(styles['panel__manifest'], 'text-body-3')}>
          <li>
            <strong>Only entered substrings are masked</strong> — geometry, dates, numeric values,
            and any text not covered by a rule survive in the output.
          </li>
          <li>Images, vector graphics, and non-text content are not extracted.</li>
        </ul>
        <p className={cn(styles['panel__note'], 'text-body-3')}>
          The file is saved from this page — nothing is uploaded. The output is a positioned-text
          JSON file, not a PDF.
        </p>
      </section>

      <Suggestions
        suggestions={filteredSuggestions}
        onAdd={onAddSuggestion}
        onDismiss={onDismissSuggestion}
      />

      <RulesEditor
        rules={rules}
        ruleMatches={ruleMatches}
        onRuleChange={onRuleChange}
        onAddRule={onAddRule}
        onRemoveRule={onRemoveRule}
      />

      {activeRules.length > 0 ? (
        <p className={cn(styles['panel__note'], 'text-body-3')}>
          {totalMatches === 0
            ? 'No matches found — check the substrings above.'
            : `${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'} across ${activeRules.length} ${activeRules.length === 1 ? 'rule' : 'rules'}.`}
        </p>
      ) : null}

      <RunsView document={anonymized} originalDocument={value} onRunClick={onRunClick} />

      <div className={styles['panel__actions']}>
        <button type="button" className="button-2" onClick={download}>
          Download anonymized JSON
        </button>
      </div>
    </section>
  )
}

export { PdfAnonymizePanel, type PdfAnonymizePanelProps }
