import type { Client } from '@wildflowerhealthio/authorization-core/domain'
import { formatInstant } from '../format-date.ts'

import type { ClientSwitch } from '../queries/index.ts'

/** How one client renders in the "Trusted Apps" list. */
interface TrustedAppRow {
  readonly subtitle: string
  /** Whether the client is disabled — it carries a `disabledAt`. */
  readonly disabled: boolean
  /**
   * The one switch the row offers: `disable` while trusted, `enable` while
   * disabled. `null` for the first-party host, which can't be disabled (the
   * server refuses it with `409 HostAppClientLocked`).
   */
  readonly action: ClientSwitch | null
}

/**
 * Derive a client's row: its id plus when it was trusted or disabled, and
 * which switch to offer.
 */
const trustedAppRow = (client: Client.Type): TrustedAppRow => ({
  subtitle: client.firstParty
    ? `${client.clientId} · Built in`
    : `${client.clientId} · ${statusOf(client)}`,
  disabled: client.disabledAt !== null,
  action: switchFor(client),
})

const statusOf = (client: Client.Type): string =>
  client.disabledAt === null
    ? `Trusted ${formatInstant(client.registeredAt)}`
    : `Disabled ${formatInstant(client.disabledAt)}`

/** The switch that flips the client's current state; none for the host. */
const switchFor = (client: Client.Type): ClientSwitch | null => {
  if (client.firstParty) return null
  return client.disabledAt === null ? 'disable' : 'enable'
}

export { trustedAppRow }
export type { TrustedAppRow }
