import { DateTime } from 'effect'

import { formatInstant } from '../format-date.ts'
import type { Client, ClientSwitch } from '../queries/index.ts'

/** How one client renders in the "Trusted Apps" list. */
interface TrustedAppRow {
  readonly subtitle: string
  /**
   * Whether the client is disabled as of `now`. A disable scheduled for later
   * hasn't happened yet, so it's still `false`.
   */
  readonly disabled: boolean
  /**
   * The one switch the row offers: `disable` while trusted, and `enable` once
   * a `disabledAt` is set (whether it has arrived or is still scheduled).
   * `null` for the first-party host, which can't be disabled (the server
   * refuses it with `409 FirstPartyClientLocked`).
   */
  readonly action: ClientSwitch | null
}

/**
 * Derive a client's row as of `now`: its id plus when it was trusted,
 * disabled, or is scheduled to be disabled, and which switch to offer.
 */
const trustedAppRow = (client: Client, now: DateTime.Utc): TrustedAppRow => {
  const disabled = client.disabledAt !== null && DateTime.lessThanOrEqualTo(client.disabledAt, now)
  return {
    subtitle: client.firstParty
      ? `${client.clientId} · Built in`
      : `${client.clientId} · ${statusOf(client, disabled)}`,
    disabled,
    action: switchFor(client),
  }
}

const statusOf = (client: Client, disabled: boolean): string => {
  if (client.disabledAt === null) return `Trusted ${formatInstant(client.registeredAt)}`
  return `${disabled ? 'Disabled' : 'Disables'} ${formatInstant(client.disabledAt)}`
}

/** The switch that flips the client's current state; none for the host. */
const switchFor = (client: Client): ClientSwitch | null => {
  if (client.firstParty) return null
  return client.disabledAt === null ? 'disable' : 'enable'
}

export { trustedAppRow }
export type { TrustedAppRow }
