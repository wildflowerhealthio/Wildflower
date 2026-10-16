import { useContextOrThrow } from '@wildflowerhealthio/react-kitchen-sink'
import type { ListedServer } from '@wildflowerhealthio/servers-core-js'
import { createContext } from 'react'

/**
 * The server whose page is open, as the cached server list holds it: given
 * by `ServerPage` to the tab its child route renders.
 */
const ListedServerContext = createContext<ListedServer.Type | null>(null)

/** The server whose page is open, from {@link ListedServerContext}. */
const useListedServer = (): ListedServer.Type => useContextOrThrow(ListedServerContext)

export { ListedServerContext, useListedServer }
