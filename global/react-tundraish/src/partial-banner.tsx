import type { JSX, ReactNode } from 'react'

import { LinkButton } from './link-button.tsx'
import styles from './partial-banner.module.css'

interface PartialBannerProps {
  /** The banner copy; keep it to a sentence or two. */
  readonly children: ReactNode
  /** An optional link-text action rendered inline after the copy. */
  readonly action?: { readonly label: string; readonly onClick: () => void }
}

/**
 * An amber **partial-data banner**: a breathing dot beside one line of copy,
 * for a body rendered from an incomplete data set that is (or could be)
 * still filling in. Callers own the copy; the optional action is the
 * load-the-rest affordance.
 *
 * The warning-amber tone reads the shared `--color-warning-*` semantic tokens,
 * the same ones the yellow `StatusBadge` uses, so the two warning surfaces stay
 * in lockstep.
 */
const PartialBanner = ({ children, action }: PartialBannerProps): JSX.Element => (
  <div className={styles['banner']} role="status">
    <span aria-hidden="true" className={styles['dot']} />
    <p className={styles['message']}>
      {children}
      {action !== undefined && (
        <>
          {' '}
          <LinkButton className={styles['action']} onClick={action.onClick}>
            {action.label}
          </LinkButton>
        </>
      )}
    </p>
  </div>
)

export { PartialBanner }
export type { PartialBannerProps }
