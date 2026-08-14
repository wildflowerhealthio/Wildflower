import appsSpec from '../../../slices/apps/apps-rust/openapi/apps.openapi.json'
import collectorSpec from '../../../slices/collector/collector-rust/openapi/collector.openapi.json'
import databasesSpec from '../../../slices/databases/databases-rust/openapi/databases.openapi.json'
import fhirSpec from '../../../slices/emr/emr-rust/openapi/fhir-r4.openapi.json'
import gatekeeperSpec from '../../../slices/gatekeeper/gatekeeper-rust/openapi/gatekeeper-oauth.openapi.json'
import tunnelSpec from '../../../slices/tunnel/tunnel-rust/openapi/tunnel-admin.openapi.json'

import type { OpenApiDocument } from './spec.ts'

/**
 * The documented slices, in the order the running host lists them at `/docs`.
 *
 * The specs are the **committed snapshots** — the same files the Rust snapshot
 * tests and `api-sync.yml` hold to the live routes — imported straight from
 * their `slices/**` homes and bundled in. So this page ships whatever the
 * drift guard last agreed on, without the deploy having to compile the host.
 */
export interface DocSource {
  /** Sidebar heading. Matches the host's `/docs` group name exactly. */
  readonly title: string
  /** URL-safe id Scalar uses for the source in its routing. */
  readonly slug: string
  /** The slice's committed OpenAPI snapshot. */
  readonly spec: OpenApiDocument
}

export const docSources: readonly DocSource[] = [
  { title: 'Gatekeeper', slug: 'gatekeeper', spec: gatekeeperSpec },
  { title: 'Apps', slug: 'apps', spec: appsSpec },
  { title: 'Databases', slug: 'databases', spec: databasesSpec },
  { title: 'Collector', slug: 'collector', spec: collectorSpec },
  { title: 'Tunnel', slug: 'tunnel', spec: tunnelSpec },
  { title: 'FHIR R4', slug: 'fhir-r4', spec: fhirSpec },
]
