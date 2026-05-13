import { deepFreeze } from 'kitchen-sink'
import type * as EntityDefinition from './entity-definition.ts'

/**
 * Declarative description of a remote-data-source *kind* — just the
 * static recognizer/parser surface, no dispatch state and no
 * per-instance configuration. A `RemoteKind` says "here are the
 * entity definitions for this collector's responses"; the
 * per-instance `firstPage` (which URL or inline HTML to load) lives
 * with the concrete client (see `fhir-r4-client-collector`'s
 * `firstPage(config)`) since it depends on user-supplied config.
 * Wiring this up to a live network stream is the job of
 * `CollectorBridgeMessageHandler.make({ remote, sendMessage,
 * onResult })`, which closes over a private `MutableHashMap` of
 * in-progress responses and exposes the bridge-shaped
 * `ResponseStart` / `ResponseData` / `ResponseFinished` /
 * `RequestError` / `Cancelled` handlers (each returning `Effect<void>`).
 *
 * Splitting the shape from the state machine keeps `RemoteKind`
 * testable with literal equality (`expect(remote).toEqual(...)`) and
 * lets tests build a fresh handle per case without re-declaring
 * entity definitions or fixtures.
 *
 * Import callers use the file as a namespace:
 * `import { RemoteKind } from 'collector-fundamentals/model'` →
 * `RemoteKind.RemoteKind<T>` for the type, `RemoteKind.make({...})`
 * for the constructor.
 *
 * - `name`: stable identifier for logs / UI.
 * - `entityDefinitions`: ordered list of recognizer/parser pairs.
 *   `CollectorBridgeMessageHandler` consults `isFoundAt` against each
 *   response URL; the first match wins.
 */
interface RemoteKind<TResources> {
  readonly name: string
  readonly entityDefinitions: readonly EntityDefinition.EntityDefinition<TResources>[]
}

/**
 * Shallow-clone + deep-freeze the supplied config. Freezing matters
 * because the dispatcher pins the matched entity per in-flight
 * request at `ResponseStart` and assumes `entityDefinitions` doesn't
 * shift under it; freezing also keeps the type-level `readonly` honest
 * at runtime so a caller can't push into `entityDefinitions` after
 * construction.
 */
const make = <TResources>(config: RemoteKind<TResources>): RemoteKind<TResources> =>
  deepFreeze({
    name: config.name,
    entityDefinitions: config.entityDefinitions,
  })

export { make }
export type { RemoteKind }
