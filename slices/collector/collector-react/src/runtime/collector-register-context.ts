import { createContext } from 'react'

import type { CollectorRegister } from './http-collector-transport.ts'

/**
 * The register/unregister pair the sync runner installs its per-run handler
 * record through — backed by the HTTP transport's `/sniffer/events`
 * WebSocket (see `http-collector-transport.ts`). Provided by
 * `CollectorHttpTransportProvider`; read via `useCollectorRegister`.
 */
const CollectorRegisterContext = createContext<CollectorRegister | null>(null)

export { CollectorRegisterContext }
