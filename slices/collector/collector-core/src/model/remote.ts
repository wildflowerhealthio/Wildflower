import type * as EntityDefinition from './entity-definition.ts'
import type * as WebViewSource from './web-view-source.ts'

/**
 * Declarative description of a remote data source — just data, no
 * dispatch state. A `Remote` says "this is what to load first, and
 * here are the entity definitions that recognize + parse responses
 * the sniffer captures." Wiring it up to a live network stream is
 * the job of `CollectorBridgeMessageHandler.make({ remote,
 * sendMessage, onResult })`, which closes over a private
 * `MutableHashMap` of in-progress responses and exposes the
 * bridge-shaped `ResponseStart` / `ResponseData` /
 * `ResponseFinished` / `RequestError` handlers (each returning
 * `Effect<void>`).
 *
 * Splitting the shape from the state machine keeps `Remote` testable
 * with literal equality (`expect(remote).toEqual(...)`) and lets
 * tests build a fresh handle per case without re-declaring entity
 * definitions or fixtures.
 *
 * Import callers use the file as a namespace:
 * `import { Remote } from 'collector-core/model'` →
 * `Remote.Remote<T>` for the type, `Remote.make({...})` for the
 * constructor.
 *
 * - `name`: stable identifier for logs / UI.
 * - `firstPage`: where to start the sync. A {@link WebViewSource.Uri}
 *   points at a remote page; a {@link WebViewSource.Html} is an
 *   inline bootstrap page (e.g. fhir-r4-client-collector's
 *   `buildFhirBootstrapHtml`).
 * - `entityDefinitions`: ordered list of recognizer/parser pairs.
 *   `CollectorBridgeMessageHandler` consults `isFoundAt` against each
 *   response URL; the first match wins.
 */
interface Remote<TResources> {
  readonly name: string
  readonly firstPage: WebViewSource.Any
  readonly entityDefinitions: readonly EntityDefinition.EntityDefinition<TResources>[]
}

/**
 * Identity factory. The body is a config-shaped clone today, but
 * routing through `make` matches the convention used elsewhere
 * (`Bridge.make`, `EntityDefinition.make`, ...) and gives a single
 * place to add behavior (validation, frozen-readonly wrapping, ...)
 * if the shape ever evolves.
 */
const make = <TResources>(config: Remote<TResources>): Remote<TResources> => {
  return {
    name: config.name,
    firstPage: config.firstPage,
    entityDefinitions: config.entityDefinitions,
  }
}

export { make }
export type { Remote }
