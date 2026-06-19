import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ItemList } from 'react-tundraish'

import { AdvancedChip } from './AdvancedChip.tsx'
import styles from './RelaySettingsEntry.module.css'

interface RelaySettingsEntryProps {
  readonly className?: string
  /**
   * Optional override for the navigation destination. The Relay
   * settings detail page is the next slice; until it lands the
   * default value points at the stubbed path so the link still
   * navigates (to a 404 today) rather than fabricating a typed route.
   */
  readonly href?: string
}

/**
 * The tappable navigation card sitting at the bottom of the Tunnel
 * overview screen — tapping anywhere on the row routes to the Relay
 * settings detail page. Single-row `<ItemList>` so the row chrome,
 * hit-area handling, and routing all flow through the shared list
 * primitive.
 *
 * The title carries an inline "Advanced" chip to signal the
 * setup-level nature of the destination; the right edge carries an
 * accent chevron as the visual affordance.
 */
const RelaySettingsEntry = ({
  className,
  href = '/settings/tunnel/relay',
}: RelaySettingsEntryProps): JSX.Element => (
  <div className={cn(styles['card'], className)}>
    <ItemList
      items={[
        {
          id: 'relay-settings',
          href,
          title: (
            <>
              Relay settings
              <AdvancedChip className={styles['title-chip']} />
            </>
          ),
          meta: (
            <span className={styles['chevron']} aria-hidden="true">
              ›
            </span>
          ),
        },
      ]}
    />
  </div>
)

export { RelaySettingsEntry }
export type { RelaySettingsEntryProps }
