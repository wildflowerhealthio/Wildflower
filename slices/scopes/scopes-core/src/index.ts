/**
 * `scopes-core` — the canonical, framework-free scope model for the Wildflower
 * scope picker. A faithful TypeScript mirror of `scopes-rust`'s `Scope` model:
 * the `Scope` union ({@link Scope}), the {@link Grant} (a `Vec<Scope>`),
 * scope-string (de)serialization, the wildcard resolution (§3) and request-clamp
 * (§2) algorithms, the v1 Read/Write access components, and display labels.
 * Every scope UI component renders from these pure functions.
 */

export type {
  Access,
  Action,
  ContextLevel,
  FhirResourceScope,
  Grant,
  KnownScope,
  RequestEnvelope,
  RequestedFlag,
  RequestedResource,
  ResourceScope,
  ResourceType,
  Scope,
  WildflowerResource,
  WildflowerResourceScope,
  WildflowerResourceType,
} from './model.ts'
export {
  ACTION_ORDER,
  ALL_PATIENTS,
  CONTEXT_LEVELS,
  KNOWN_SCOPES,
  OFFERABLE_CONTEXTS,
  VERB,
  WILDFLOWER_CONTEXT,
  WILDFLOWER_RESOURCES,
} from './model.ts'

export {
  accessForm,
  accessFromComponents,
  accessHas,
  accessLetters,
  accessSubsetOf,
  coversComponent,
  isEmptyAccess,
  lettersAccess,
  parseAccess,
  readAccess,
  serializeAccess,
  sortActions,
  starAccess,
  WORD_COMPONENT_LABEL,
  WORD_COMPONENTS,
  wordComponentsOf,
  writeAccess,
  type WordComponent,
} from './access.ts'

export {
  fhirBucket,
  fhirResourceName,
  fhirResourceType,
  findResource,
  findWildcard,
  flagScopes,
  hasFlag,
  inBucket,
  knownScope,
  makeResourceScope,
  resourceScopeName,
  resourceScopes,
  unknownScope,
  unknownScopes,
  wildflowerBucket,
  wildflowerResourceName,
  wildflowerResourceType,
  type Bucket,
} from './scope.ts'

export { accessVerbLabel, verbLabel } from './verbs.ts'

export {
  bucketPrefix,
  parseResourceScope,
  parseScope,
  scopeCode,
  serializeAll,
  serializeGrant,
  serializeScope,
} from './serialize.ts'

export {
  effectiveCell,
  removeResource,
  setFlag,
  toggleCell,
  toggleFlag,
  toggleWordComponent,
  type EffectiveCell,
} from './resolve.ts'

export {
  buildCell,
  buildWordCell,
  envelopeResourceFor,
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
