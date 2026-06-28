/**
 * `scopes-core` — the canonical, framework-free scope model for the Wildflower
 * scope picker. A faithful TypeScript mirror of `scopes-rust`'s `Scope` model:
 * the {@link Grant} types, scope-string (de)serialization, the wildcard
 * resolution (§3) and request-clamp (§2) algorithms, the v1 Read/Write access
 * components, and display labels. Every scope UI component renders from these
 * pure functions; no view holds its own permission state.
 */

export type {
  Access,
  AccessWord,
  Action,
  Context,
  FlagScope,
  Grant,
  RequestEnvelope,
  ScopePermission,
} from './model.ts'
export { ACTION_ORDER, ALL_PATIENTS, FLAG_SCOPES, OFFERABLE_CONTEXTS, VERB } from './model.ts'

export {
  accessFromComponents,
  accessHas,
  accessLetters,
  accessSubsetOf,
  coversComponent,
  lettersAccess,
  parseAccess,
  serializeAccess,
  sortActions,
  wordAccess,
  wordComponentsOf,
  WORD_COMPONENT_LABEL,
  WORD_COMPONENTS,
  type WordComponent,
} from './access.ts'

export { accessVerbLabel, verbLabel } from './verbs.ts'

export {
  parsePermission,
  parseScope,
  scopeCode,
  serializeAll,
  serializeGrant,
  serializePermission,
  type ParsedScope,
} from './serialize.ts'

export {
  effectiveCell,
  removePermission,
  toggleCell,
  toggleWordComponent,
  type EffectiveCell,
} from './resolve.ts'

export {
  buildCell,
  buildWordCell,
  envelopePermissionFor,
  flagDisabled,
  flagRequired,
  isWithinEnvelope,
  resourceAccessForm,
  type Cell,
  type CellState,
} from './clamp.ts'

export {
  FHIR_LABELS,
  FLAG_COPY,
  resourceLabel,
  resourcePlural,
  WILDCARD_LABEL,
  WILDCARD_NOTE,
  WILDFLOWER_LABELS,
  type ResourceLabel,
} from './labels.ts'
