import type { ConfigFormProps } from 'collector-fundamentals/config-form'
import { type CollectorTag, type ConfigForTag } from 'collector-registry/registry'
import { FhirR4ConfigForm } from 'fhir-r4-client-collector'
import type { JSX } from 'react'

/**
 * A per-collector config form, keyed to its tag: the form for `T` is written
 * against `T`'s own concrete config ({@link ConfigForTag}), so no union erasure
 * or runtime narrowing is needed — the tag carries the config type.
 */
type ConfigFormComponent<T extends CollectorTag> = (
  props: ConfigFormProps<ConfigForTag<T>>
) => JSX.Element

/**
 * The **closed, compile-time** `tag → ConfigForm` map: the React half of the
 * two-part descriptor (the data half lives in `collector-registry`). This is
 * the single edit point for wiring a collector's UI — register its form here.
 *
 * The `{ [T in CollectorTag]: ConfigFormComponent<T> }` mapped type is both the
 * exhaustiveness lock and the per-tag type binding: adding a descriptor to
 * `collector-registry` widens `CollectorTag`, and this record then fails to
 * compile until the new collector's form is registered, and each entry is
 * checked against *its own* config (there is no unknown-tag path —
 * {@link configFormForTag} is total over `CollectorTag`).
 *
 * This is step 8 of the recipe in
 * `slices/collector/docs/Adding a Collector How-To.md`.
 */
const configForms: { readonly [T in CollectorTag]: ConfigFormComponent<T> } = {
  'fhir-r4': FhirR4ConfigForm,
}

/**
 * Resolve the form for a collector `tag`. Total over {@link CollectorTag}.
 * Generic over the tag so indexing the mapped {@link configForms} returns the
 * precise `ConfigFormComponent<T>` — the account screen stays generic on `T`
 * end-to-end, no cast.
 */
const configFormForTag = <T extends CollectorTag>(tag: T): ConfigFormComponent<T> =>
  configForms[tag]

export { configForms, configFormForTag }
export type { ConfigFormComponent }
