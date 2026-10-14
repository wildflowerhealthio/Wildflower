import type { Client } from '@wildflowerhealthio/authorization-react'

/**
 * The name `clientId` registered under, for the reader: client ids are random
 * and opaque. The id itself until the trusted apps have loaded, or for a
 * client that registered no name.
 */
const clientNameOf = (clients: readonly Client[] | undefined, clientId: string): string => {
  const name = clients?.find((client) => client.clientId === clientId)?.name ?? ''
  return name === '' ? clientId : name
}

export { clientNameOf }
