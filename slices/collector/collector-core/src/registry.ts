import type { Remote } from 'collector-fundamentals/model'
import { Schema } from 'effect'
import {
  InstanceConfig as FhirR4InstanceConfig,
  type AnyResource as FhirR4AnyResource,
  makeFhirR4Remote,
} from 'fhir-r4-client-collector'

/**
 * Closed discriminated union of every collector's per-instance config.
 *
 * `collector-core` statically imports each concrete client package
 * (`fhir-r4-client-collector`, …) and assembles them here. Adding a
 * new collector is an edit to this file plus a new `package.json` dep
 * — there is intentionally no runtime registry. The livestore
 * `remotes.config` column, the `CollectorApi.{Create,Update}Remote`
 * payloads, and any host-side `makeRemoteForConfig` dispatch all
 * derive from this single union.
 */
const CollectorConfig = Schema.Union(FhirR4InstanceConfig)
type CollectorConfig = typeof CollectorConfig.Type

/**
 * The narrow set of `_tag` literals the union currently admits.
 * Useful as the schema of the `remotes.tag` column and as the
 * branching surface of any host-side switch (`switch (config._tag)`).
 *
 * Annotated as `Schema.Schema<CollectorConfig['_tag']>` so adding a
 * new collector to the union without widening this literal list is
 * a compile error — the schema-vs-type-derivation parallel stays
 * locked.
 */
type CollectorTag = CollectorConfig['_tag']
const CollectorTag: Schema.Schema<CollectorTag> = Schema.Literal('fhir-r4')

/**
 * Every resource shape any collector might produce. Used as the
 * generic argument of the per-config `Remote` returned by
 * {@link makeRemoteForConfig} — callers downstream of the dispatcher
 * accept the union and narrow as needed.
 */
type AnyCollectorResource = FhirR4AnyResource

/**
 * Build the concrete `Remote` for a stored `CollectorConfig`. Drives
 * the wire-level dispatch in `CollectorBridgeMessageHandler` (which
 * consumes the returned `Remote.entityDefinitions`).
 *
 * The function is intentionally exhaustive — the `never`-typed
 * `default` branch turns a missing case into a compile-time error if
 * the union ever widens without a matching dispatch arm.
 */
const makeRemoteForConfig = (config: CollectorConfig): Remote.Remote<AnyCollectorResource> => {
  switch (config._tag) {
    case 'fhir-r4':
      return makeFhirR4Remote(config)
    default: {
      const exhaustive: never = config._tag
      throw new Error(`unknown collector config tag: ${String(exhaustive)}`)
    }
  }
}

export { CollectorConfig, CollectorTag, makeRemoteForConfig }
export type { AnyCollectorResource }
