import type { Document } from 'positioned-text'
import { useCallback, useState, type JSX, type KeyboardEvent } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './pdf-anonymize-panel.module.css'

interface RunsViewProps {
  readonly document: Document.Type
  readonly originalDocument?: Document.Type
  readonly onRunClick?: (text: string) => void
  readonly className?: string
}

const RunsView = ({
  document: doc,
  originalDocument,
  onRunClick,
  className,
}: RunsViewProps): JSX.Element => {
  const [hoveredRun, setHoveredRun] = useState<string | null>(null)

  const handleClick = useCallback(
    (text: string) => {
      if (onRunClick && text.trim() !== '') onRunClick(text)
    },
    [onRunClick]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent, text: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleClick(text)
      }
    },
    [handleClick]
  )

  return (
    <div className={cn(styles['runs'], className)}>
      {doc.pages.map((page, pageIndex) => {
        const originalPage = originalDocument?.pages[pageIndex]
        return (
          <div
            key={page.pageNumber}
            className={styles['runs__page']}
            style={{
              aspectRatio: `${page.width} / ${page.height}`,
            }}
            aria-label={`Page ${page.pageNumber}`}
          >
            {page.runs.map((run, i) => {
              const originalRun = originalPage?.runs[i]
              const isMasked = originalRun !== undefined && originalRun.text !== run.text
              const runKey = `${pageIndex}-${i}`
              const showOriginal = isMasked && hoveredRun === runKey

              return (
                <span
                  key={i}
                  className={cn(
                    styles['runs__span'],
                    'text-body-3',
                    onRunClick && styles['runs__span--interactive'],
                    isMasked && styles['runs__span--masked']
                  )}
                  style={{
                    left: `${(run.x / page.width) * 100}%`,
                    top: `${(run.y / page.height) * 100}%`,
                    fontSize: `${(run.fontSize / page.width) * 100}cqi`,
                  }}
                  role={onRunClick ? 'button' : undefined}
                  tabIndex={onRunClick ? 0 : undefined}
                  onClick={() => handleClick(run.text)}
                  onKeyDown={onRunClick ? (e) => handleKeyDown(e, run.text) : undefined}
                  onMouseEnter={() => {
                    if (isMasked) setHoveredRun(runKey)
                  }}
                  onMouseLeave={() => setHoveredRun(null)}
                  title={isMasked ? `Original: ${originalRun.text}` : undefined}
                >
                  {showOriginal ? originalRun.text : run.text}
                </span>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

export { RunsView, type RunsViewProps }
