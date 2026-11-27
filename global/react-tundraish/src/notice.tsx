import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { ComponentProps, JSX, ReactNode } from 'react'

import { LinkButton } from './link-button.tsx'
import styles from './notice.module.css'

/** What a {@link Notice} says about what happened: something failed, or something finished. */
type NoticeTone = 'danger' | 'success'

/**
 * How each tone is drawn and announced: the live-region role, the leading
 * glyph (decorative), and the word a screen reader hears before the message
 * in its place — the same words `StatusBadge` uses.
 */
const toneLook: Record<
  NoticeTone,
  { readonly role: 'alert' | 'status'; readonly glyph: string; readonly srWord: string }
> = {
  danger: { role: 'alert', glyph: '⚠', srWord: 'Error: ' },
  success: { role: 'status', glyph: '✓', srWord: 'Success: ' },
}

/**
 * Props for {@link Notice}: its tone, message, details and action, and any
 * other `<div>` prop (`id`, `aria-*`, `data-*`, `ref`, a `className` added to
 * its own), which go to the root. The tone sets the root's `role`, so a
 * caller cannot.
 */
interface NoticeProps extends Omit<ComponentProps<'div'>, 'role' | 'children'> {
  readonly tone: NoticeTone
  /** The message; keep it to a sentence or two. */
  readonly children: ReactNode
  /** More about the message, under it: a list of issues, a disclosure. */
  readonly details?: ReactNode
  /** An optional link-text action rendered inline after the message. */
  readonly action?: { readonly label: string; readonly onClick: () => void }
}

/**
 * An inline **notice**: a message in a tinted callout whose tone says what
 * happened — `danger` for something that failed (a `role="alert"`), `success`
 * for something that finished (a `role="status"`). A leading glyph marks the
 * tone for the eye and a screen-reader-only word ("Error: ", "Success: ")
 * for the ear, so colour is never the only channel.
 *
 * `ErrorBanner` draws its message callout through this, so a thrown error
 * and a message a caller words itself look and announce the same.
 */
const Notice = ({
  tone,
  children,
  details,
  action,
  className,
  ...rest
}: NoticeProps): JSX.Element => {
  const look = toneLook[tone]
  return (
    <div
      {...rest}
      className={cn(styles['notice'], styles[`notice--${tone}`], className)}
      role={look.role}
    >
      <span aria-hidden="true" className={styles['notice__glyph']}>
        {look.glyph}
      </span>
      <div className={styles['notice__body']}>
        <p className={cn(styles['notice__message'], 'text-body-3')}>
          <span className="sr-only">{look.srWord}</span>
          {children}
          {action !== undefined && (
            <>
              {' '}
              <LinkButton onClick={action.onClick}>{action.label}</LinkButton>
            </>
          )}
        </p>
        {details !== undefined && (
          <div className={cn(styles['notice__details'], 'text-body-3')}>{details}</div>
        )}
      </div>
    </div>
  )
}

export { Notice }
export type { NoticeProps, NoticeTone }
