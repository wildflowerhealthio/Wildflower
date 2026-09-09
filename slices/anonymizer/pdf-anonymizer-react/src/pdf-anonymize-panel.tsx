import {
  applySubstitutions,
  type PositionedTextDocument,
  type SubstitutionRule,
} from 'pdf-anonymizer-core'
import { useCallback, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ToggleSwitch } from 'react-tundraish'

import { anonymizedJsonFileName, downloadBlob, positionedTextBlob } from './download-json.ts'
import { RulesEditor } from './rules-editor.tsx'
import { RunsView } from './runs-view.tsx'
import styles from './pdf-anonymize-panel.module.css'

interface PdfAnonymizePanelProps {
  readonly value: PositionedTextDocument
  readonly fileName: string
  readonly className?: string
}

let nextRuleId = 0
const freshId = (): string => `rule-${++nextRuleId}`

const PdfAnonymizePanel = ({ value, fileName, className }: PdfAnonymizePanelProps): JSX.Element => {
  const [rules, setRules] = useState<SubstitutionRule[]>(() => [{ id: freshId(), text: '' }])
  const [showAnonymized, setShowAnonymized] = useState(false)

  const { document: anonymized, ruleMatches } = useMemo(
    () => applySubstitutions(value, rules),
    [value, rules]
  )

  const displayed = showAnonymized ? anonymized : value

  const totalRuns = value.pages.reduce((sum, page) => sum + page.runs.length, 0)
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

      <div className={styles['panel__preview-controls']}>
        <ToggleSwitch
          checked={showAnonymized}
          label="Show anonymized preview"
          onChange={setShowAnonymized}
        />
      </div>

      <RunsView document={displayed} />

      <div className={styles['panel__actions']}>
        <button type="button" className="button-2" onClick={download}>
          Download anonymized JSON
        </button>
      </div>
    </section>
  )
}

export { PdfAnonymizePanel, type PdfAnonymizePanelProps }
