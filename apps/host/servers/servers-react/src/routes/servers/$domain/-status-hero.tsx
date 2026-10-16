import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { StatusBadge } from '@wildflowerhealthio/react-tundraish'
import type { ListedServer } from '@wildflowerhealthio/servers-core-js'
import { type JSX, useEffect, useRef, useState } from 'react'

import { formatInstant, statusSummary } from '../../../server-status-text.ts'
import { useHiddenEnds } from './-hidden-ends.ts'
import styles from './-status-hero.module.css'

/** How long the check mark shows once the domain is copied, in milliseconds. */
const COPIED_MARK_MS = 1500

/** Where copying the domain to the clipboard stands. */
type CopyOutcome = 'idle' | 'copied' | 'refused'

/** What the hero's live region announces for each copy outcome. */
const COPY_ANNOUNCEMENT: Readonly<Record<CopyOutcome, string>> = {
  idle: '',
  copied: 'Copied',
  refused: 'The clipboard refused. Select the domain to copy it by hand.',
}

/** Where copying the domain stands, and how many times it has been copied. */
interface CopyState {
  readonly outcome: CopyOutcome
  /** Counts each copy, so a copy made while the mark still shows starts it again. */
  readonly copies: number
}

/** Copying `domain` to the clipboard: where it stands, and how to copy it. */
interface DomainCopy extends CopyState {
  readonly copy: () => Promise<void>
}

/**
 * Copies `domain` to the clipboard on request, `copied` for
 * {@link COPIED_MARK_MS} and then `idle` again, or `refused` until the next
 * try when the clipboard refuses.
 *
 * @remarks
 * The clipboard needs a focused, secure page and may still refuse; the domain
 * is on screen to copy by hand either way.
 */
const useDomainCopy = (domain: string): DomainCopy => {
  const [state, setState] = useState<CopyState>({ outcome: 'idle', copies: 0 })
  useEffect(() => {
    if (state.outcome !== 'copied') return undefined
    const timer = setTimeout(() => {
      setState(({ copies }) => ({ outcome: 'idle', copies }))
    }, COPIED_MARK_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [state])
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(domain)
      setState(({ copies }) => ({ outcome: 'copied', copies: copies + 1 }))
    } catch {
      setState(({ copies }) => ({ outcome: 'refused', copies }))
    }
  }
  return { ...state, copy }
}

/** A check mark, drawn in the text's colour. */
const CheckMark = (): JSX.Element => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false">
    <path
      d="M3 8.5 6.5 12 13 4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/**
 * The top of a server's page, set as its title rather than in a card: its
 * domain on one line, scrolling sideways with a fade on each end with text
 * past it, which copies itself when tapped, a check mark bouncing in beside
 * it and a live region saying so; and under it, its status, merged from its
 * run state and health, with when its run started while it runs.
 */
const StatusHero = ({ server }: { readonly server: ListedServer.Type }): JSX.Element => {
  const status = statusSummary(server.status)
  const domainRef = useRef<HTMLHeadingElement>(null)
  const hiddenEnds = useHiddenEnds(domainRef)
  const { outcome, copies, copy } = useDomainCopy(server.domain)
  return (
    <section className={styles['status-hero']} aria-label="Status">
      <div className={styles['status-hero__title-row']}>
        <h2
          ref={domainRef}
          className={cn(
            styles['status-hero__domain'],
            hiddenEnds.before && styles['status-hero__domain--hidden-before'],
            hiddenEnds.after && styles['status-hero__domain--hidden-after']
          )}
        >
          <button
            type="button"
            className={styles['status-hero__copy']}
            title="Copy the domain"
            onClick={() => {
              void copy()
            }}
          >
            {server.domain}
          </button>
        </h2>
        {outcome === 'copied' ? (
          <span key={copies} className={styles['status-hero__copied']}>
            <CheckMark />
          </span>
        ) : null}
      </div>
      <p
        role="status"
        className={outcome === 'refused' ? `text-body-3 ${styles['status-hero__note']}` : 'sr-only'}
      >
        {COPY_ANNOUNCEMENT[outcome]}
      </p>
      <div className={styles['status-hero__status-row']}>
        <StatusBadge tone={status.tone} pulse={status.tone === 'success'}>
          {status.label}
        </StatusBadge>
        {server.status.runState === 'running' ? (
          <span className={`text-body-3 ${styles['status-hero__note']}`}>
            Since {formatInstant(server.status.runningSince)}
          </span>
        ) : null}
      </div>
    </section>
  )
}

export { StatusHero }
