import type { PositionedTextDocument } from 'pdf-anonymizer-core'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './pdf-anonymize-panel.module.css'

interface RunsViewProps {
  readonly document: PositionedTextDocument
  readonly className?: string
}

const RunsView = ({ document: doc, className }: RunsViewProps): JSX.Element => (
  <div className={cn(styles['runs'], className)}>
    {doc.pages.map((page) => (
      <div
        key={page.pageNumber}
        className={styles['runs__page']}
        style={{
          aspectRatio: `${page.width} / ${page.height}`,
        }}
        aria-label={`Page ${page.pageNumber}`}
      >
        {page.runs.map((run, i) => (
          <span
            key={i}
            className={cn(styles['runs__span'], 'text-body-3')}
            style={{
              left: `${(run.x / page.width) * 100}%`,
              top: `${(run.y / page.height) * 100}%`,
              fontSize: `${(run.fontSize / page.width) * 100}cqi`,
            }}
          >
            {run.text}
          </span>
        ))}
      </div>
    ))}
  </div>
)

export { RunsView, type RunsViewProps }
