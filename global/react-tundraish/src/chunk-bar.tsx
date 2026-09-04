import type { FocusEvent, JSX } from 'react'
import { useState } from 'react'
import { cn } from 'react-kitchen-sink'

import { LinkButton } from './link-button.tsx'
import styles from './chunk-bar.module.css'

type ChunkBarPhase = 'idle' | 'loading' | 'locked'

interface ChunkBarLabels {
  /** Bar `aria-label` while idle (pages arrived, no fetch running). */
  readonly ariaIdle: (pages: number) => string
  /** Bar `aria-label` while a fetch is running. */
  readonly ariaLoading: (pages: number) => string
  /** Bar `aria-label` once every page has arrived. */
  readonly ariaLocked: string
  /** Tooltip copy after the bold count (e.g. `"items have been loaded."`). */
  readonly countSuffix: string
  /** The load-everything action's link text. */
  readonly loadAll: string
  /** Tooltip status line while a fetch is running. */
  readonly loadingNote: string
  /** Tooltip status line once every page has arrived. */
  readonly lockedNote: string
}

const defaultLabels: ChunkBarLabels = {
  ariaIdle: (pages) => `${pages} pages loaded so far`,
  ariaLoading: (pages) => `Loading — ${pages} pages in so far`,
  ariaLocked: 'Everything is loaded',
  countSuffix: 'items have been loaded.',
  loadAll: 'Load all the rest?',
  loadingNote: 'Loading the rest now — one block per page as it arrives.',
  lockedNote: 'That is all of them.',
}

interface ChunkBarProps {
  /** `idle` = pages arrived by scrolling, no fetch running. */
  readonly phase: ChunkBarPhase
  /** Pages received so far — one block each. No totals are ever shown. */
  readonly pagesReceived: number
  /** Exact count of items received, for the tooltip line. */
  readonly loadedCount: number
  /**
   * Starts the load-everything fetch. When present the tooltip offers the
   * `loadAll` action while idle; omitted, the tooltip is informational only.
   */
  readonly onLoadAll?: () => void
  /** Copy overrides; each falls back to a generic default. */
  readonly labels?: Partial<ChunkBarLabels>
}

/** Cap the lock stagger so a long bar settles in bounded time. */
const lockDelayMillis = (index: number): number => Math.min(index, 20) * 34

/**
 * A **page-chunk progress bar** for a paged fetch whose total length is
 * unknown until the last page arrives: one small block per page received, the
 * in-flight page breathing at the tail, and — when the final page lands — the
 * gaps collapsing so the blocks combine into one solid bar that stays on the
 * page. It renders no placeholder slots and no "x of y"; the bar simply grows.
 *
 * Under 4 pages it renders nothing (a short list loads fast enough to need no
 * meter); past 24 pages the blocks tighten so the bar stays in its column.
 *
 * Hovering the bar (or focusing it — the bar is in the tab order) opens a
 * tooltip stating how many items have arrived, with the load-everything
 * action while the fetch is paused. A polite live region announces progress
 * at most once per page.
 */
const ChunkBar = ({
  phase,
  pagesReceived,
  loadedCount,
  onLoadAll,
  labels,
}: ChunkBarProps): JSX.Element | null => {
  const [tipOpen, setTipOpen] = useState(false)
  if (pagesReceived < 4) return null

  const copy = { ...defaultLabels, ...labels }
  const ariaLabel = ((): string => {
    if (phase === 'locked') return copy.ariaLocked
    if (phase === 'loading') return copy.ariaLoading(pagesReceived)
    return copy.ariaIdle(pagesReceived)
  })()

  // Close only when focus leaves the whole wrapper, so tabbing from the bar
  // onto the tooltip's action keeps the tooltip open.
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) setTipOpen(false)
  }

  const startLoadAll = (): void => {
    // Starting a fetch closes the tooltip (it reopens on the next hover/focus).
    setTipOpen(false)
    onLoadAll?.()
  }

  const blocks = Array.from({ length: pagesReceived }, (_, index) => (
    <i
      key={index}
      className={styles['block']}
      style={phase === 'locked' ? { animationDelay: `${lockDelayMillis(index)}ms` } : undefined}
    />
  ))

  return (
    <div
      className={styles['barWrap']}
      onMouseEnter={() => {
        setTipOpen(true)
      }}
      onMouseLeave={() => {
        setTipOpen(false)
      }}
      onFocus={() => {
        setTipOpen(true)
      }}
      onBlur={onBlur}
    >
      <div
        className={cn(styles['bar'], styles[phase], pagesReceived > 24 && styles['dense'])}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onClick={() => {
          // Touch has no hover: tapping the bar opens the tooltip.
          setTipOpen(true)
        }}
      >
        {blocks}
        {phase === 'loading' && <i key="inflight" className={styles['inflight']} />}
      </div>
      {/* One announcement per page: the label changes only when a page lands
       * or the phase flips, so rendering it live needs no extra throttle. */}
      <span aria-live="polite" className="sr-only">
        {ariaLabel}
      </span>
      {tipOpen && (
        <div role="tooltip" className={styles['tooltip']}>
          <p className={styles['countLine']}>
            <strong className={styles['count']}>
              {new Intl.NumberFormat().format(loadedCount)}
            </strong>{' '}
            {copy.countSuffix}
          </p>
          {phase === 'idle' && onLoadAll !== undefined && (
            <LinkButton onClick={startLoadAll}>{copy.loadAll}</LinkButton>
          )}
          {phase === 'loading' && <p className={styles['note']}>{copy.loadingNote}</p>}
          {phase === 'locked' && <p className={styles['note']}>{copy.lockedNote}</p>}
        </div>
      )}
    </div>
  )
}

export { ChunkBar }
export type { ChunkBarLabels, ChunkBarPhase, ChunkBarProps }
