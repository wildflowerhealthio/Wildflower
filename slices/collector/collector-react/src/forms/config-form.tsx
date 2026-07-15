/* oxlint-disable react/only-export-components ---
  This module is the tag→ConfigForm registry: it deliberately exports the
  `configForms` map plus the `makeConfigForm`/`configFormForTag` helpers
  alongside the wrapper component `makeConfigForm` produces. None are
  HMR-relevant standalone components, so fast-refresh's one-component-per-file
  rule doesn't apply. */
import { type CollectorConfig, type CollectorTag } from 'collector-registry/registry'
import { Schema } from 'effect'
import { InstanceConfig } from 'fhir-r4-client-collector'
import type { JSX, ReactNode } from 'react'

import { FhirR4ConfigForm } from './fhir-r4-config-form.tsx'

/**
 * The props a per-collector config form receives. `Config` is the concrete
 * config for one collector (e.g. the FHIR R4 `{ _tag, rootUrl, patientId }`),
 * so each form is written against its own precise shape.
 *
 * The form owns its config fields and the submit boundary; the generic account
 * screens inject the shared chrome — the account-name field plus the type badge
 * (`header`, rendered above the fields) and the Save/Cancel row (`footer`,
 * rendered below, whose Save button is the form's `type="submit"`). A form
 * decodes on submit and calls {@link onSubmit} only with a valid `Config`.
 *
 * - `initial`: an existing remote's stored config, on the edit screen; the
 *   form seeds its fields from it. `undefined` on the create screen.
 * - `prefill`: a loose `Record<string,string>` handed off via the create
 *   screen's search params. A form reads the keys it recognises (falling back
 *   to its `defaultConfig`); callers are trusted to populate sensible keys.
 * - `disabled`: mirrors the owning mutation's pending state.
 * - `onSubmit`: called with the decoded config once the fields validate.
 */
interface ConfigFormProps<Config> {
  readonly initial: Config | undefined
  readonly prefill: Record<string, string> | undefined
  readonly disabled: boolean
  readonly onSubmit: (config: Config) => void
  readonly header: ReactNode
  readonly footer: ReactNode
}

/**
 * A config form erased to the {@link CollectorConfig} union — the shape the
 * {@link configForms} registry stores and the account screens render. The
 * per-collector `Config` narrowing is recovered by {@link makeConfigForm}, so
 * the screens can hand a union-typed `initial` to whichever form a `tag`
 * resolves to without a cast.
 */
type ErasedConfigForm = (props: ConfigFormProps<CollectorConfig>) => JSX.Element

/**
 * Erase a concretely-typed form to an {@link ErasedConfigForm}. The union
 * `initial` is narrowed to `Config` via `Schema.is(schema)` (else `undefined`,
 * so a mismatched stored config falls back to the form's own defaults) — the
 * same guard-where-the-type-is-in-scope trick the descriptor's
 * `scrapingPlanIfMatches` uses to dispatch over a heterogeneous list. `onSubmit`
 * flows through unchanged: `(CollectorConfig) => void` is contravariantly
 * assignable to `(Config) => void`.
 */
const makeConfigForm = <Config extends CollectorConfig>(
  schema: Schema.Schema<Config>,
  Form: (props: ConfigFormProps<Config>) => JSX.Element
): ErasedConfigForm => {
  const isConfig = Schema.is(schema)
  return function WrappedConfigForm(props: ConfigFormProps<CollectorConfig>): JSX.Element {
    const initial =
      props.initial !== undefined && isConfig(props.initial) ? props.initial : undefined
    return <Form {...props} initial={initial} />
  }
}

/**
 * The **closed, compile-time** `tag → ConfigForm` map: the React half of the
 * two-part descriptor (the data half lives in `collector-registry`). This is
 * the single edit point for wiring a collector's UI — register its form here.
 *
 * The `Record<CollectorTag, …>` annotation is the exhaustiveness lock: adding a
 * descriptor to `collector-registry` widens `CollectorTag`, and this record
 * then fails to compile until the new collector's form is registered (there is
 * no unknown-tag path — {@link configFormForTag} is total over `CollectorTag`).
 */
const configForms: Record<CollectorTag, ErasedConfigForm> = {
  'fhir-r4': makeConfigForm(InstanceConfig, FhirR4ConfigForm),
}

/** Resolve the form for a collector `tag`. Total over {@link CollectorTag}. */
const configFormForTag = (tag: CollectorTag): ErasedConfigForm => configForms[tag]

export { configForms, configFormForTag, makeConfigForm }
export type { ConfigFormProps, ErasedConfigForm }
