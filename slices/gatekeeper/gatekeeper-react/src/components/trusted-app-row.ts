import { formatInstant } from '../format-date.ts'
import type { Client, ClientSwitch } from '../queries/index.ts'

/** How one client renders in the "Trusted Apps" list. */
interface TrustedAppRow {
  readonly subtitle: string
  /**
   * The one switch the row offers — `disable` while trusted, `enable` while
   * disabled — or `null` for the first-party host, which can't be disabled
   * (the server refuses it with `409 FirstPartyClientLocked`).
   */
  readonly action: ClientSwitch | null
}

/**
 * Derive a client's row: its id plus when it was trusted (or disabled), and
 * which switch to offer.
 */
const trustedAppRow = (client: Client): TrustedAppRow => {
  const status =
    client.disabledAt === null
      ? `Trusted ${formatInstant(client.registeredAt)}`
      : `Disabled ${formatInstant(client.disabledAt)}`
  return {
    subtitle: client.firstParty
      ? `${client.clientId} · Built in`
      : `${client.clientId} · ${status}`,
    action: switchFor(client),
  }
}

/** The switch that flips the client's current state; none for the host. */
const switchFor = (client: Client): ClientSwitch | null => {
  if (client.firstParty) return null
  return client.disabledAt === null ? 'disable' : 'enable'
}

export { trustedAppRow }
export type { TrustedAppRow }
