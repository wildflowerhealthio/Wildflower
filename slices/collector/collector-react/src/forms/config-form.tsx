import type { ConfigFormProps } from 'collector-fundamentals/config-form'
import { type CollectorTag, type ConfigForTag } from 'collector-registry/registry'
import { FhirR4ConfigForm } from 'fhir-r4-client-collector'
import { LifeLabsConfigForm } from 'lifelabs-collector'
import { createElement, type JSX } from 'react'
import { RexallConfigForm } from 'rexall-be-well-collector'
import { ShoppersDrugMartConfigForm } from 'shoppers-drugmart-collector'
import { WebTraceConfigForm } from 'web-trace-collector'

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
 * {@link renderConfigForm} is total over `CollectorTag`).
 *
 * This is step 8 of the recipe in
 * `slices/collector/docs/Adding a Collector How-To.md`.
 */
const configForms: { readonly [T in CollectorTag]: ConfigFormComponent<T> } = {
  'fhir-r4': FhirR4ConfigForm,
  rexall: RexallConfigForm,
  'shoppers-drugmart': ShoppersDrugMartConfigForm,
  lifelabs: LifeLabsConfigForm,
  'web-trace': WebTraceConfigForm,
}

/**
 * Render the config form for a collector `tag` under `props`. Total over
 * {@link CollectorTag}. Generic over the tag so the props argument is
 * checked against *that tag's* concrete `ConfigForTag<T>` — the account
 * screen stays generic on `T` end-to-end, no cast.
 *
 * Uses `React.createElement` because a `const ConfigForm = configForms[tag]`
 * variable followed by `<ConfigForm .../>` trips react/static-components:
 * React Compiler can't prove from the JSX site that the dispatched component
 * reference is stable across renders (it is — the map is frozen and looked
 * up by primitive key). Folding the createElement call in here keeps that
 * escape hatch at the definition site, so callers read "render this tag's
 * form" without a render-local component name in their JSX.
 */
const renderConfigForm = <T extends CollectorTag>(
  tag: T,
  props: ConfigFormProps<ConfigForTag<T>>
): JSX.Element => createElement(configForms[tag], props)

export { configForms, renderConfigForm }
export type { ConfigFormComponent }
