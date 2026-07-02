import * as Contexts from './contexts/index.ts'
import * as Permission from './permission/index.ts'
import * as ResourceType from './resource-type/index.ts'

import { BaseScope, BaseResourceScope } from './scope.ts'

import FhirV1 from './fhir-scope-v1.ts'
import FhirV2 from './fhir-scope-v2.ts'
import Known from './known.ts'
import { MultiScope } from './multi-scope.ts'
import { ScopeConfiguration } from './scope-configuration.ts'
import Unknown from './unknown.ts'
import Wildflower from './wildflower-scope.ts'

// oxlint-disable import/group-exports
namespace ResourceScope {
  // oxlint-disable-next-line no-shadow
  export type Any = Wildflower | FhirV1 | FhirV2

  export const Base = BaseResourceScope
  export type Base<
    TContext extends Contexts.Context,
    TResource extends ResourceType.Base,
    TPermission extends string,
  > = BaseResourceScope<TContext, TResource, TPermission>

  /** Whether a scope is a resource scope (FHIR or Wildflower), narrowing to {@link BaseResourceScope.Base}. */
  export const isResourceScope = (s: BaseScope): s is Any => {
    return s instanceof BaseResourceScope
  }

  export const parse = (s: string): Any | null => {
    const wf = Wildflower.parse(s)
    if (wf !== null) return wf

    const fhirV1 = FhirV1.parse(s)
    if (fhirV1 !== null) return fhirV1

    const fhirV2 = FhirV2.parse(s)
    if (fhirV2 !== null) return fhirV2

    return null
  }
}

type Any = Wildflower | FhirV1 | FhirV2 | Known | Unknown

/**
 * Parse one scope string into its richest form — total (mirrors Rust's
 * `Scope::from`): known → wildflower → FHIR → unknown.
 */
const parse = (s: string): Any => {
  const resource = ResourceScope.parse(s)
  if (resource !== null) return resource

  const known = Known.parse(s)
  if (known !== null) return known

  return Unknown.parse(s)
}

export {
  BaseScope as Base,
  ResourceScope,
  type Any,
  parse,
  ScopeConfiguration,
  MultiScope,
  Contexts,
  Permission,
  ResourceType,
  FhirV1,
  FhirV2,
  Wildflower,
  Known,
  Unknown,
}
