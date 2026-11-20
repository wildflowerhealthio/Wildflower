/**
 * A person's name: the name a `Patient` or a `Practitioner` is shown by.
 *
 * @packageDocumentation
 */
import { DateTime, Effect, Option } from 'effect'

import { displayName } from '../data-types/complex/human-name-display.ts'
import type { FhirResource } from './fhir-resource.ts'

/**
 * The name `resource` is shown by when it is a Patient or a Practitioner:
 * `HumanName.displayName`'s pick among its names, a current one first, judged
 * at the clock's now.
 *
 * @returns `None` for a resource of another type, or when no name renders
 */
const maybeDisplayName = (resource: FhirResource): Effect.Effect<Option.Option<string>> =>
  resource.resourceType === 'Patient' || resource.resourceType === 'Practitioner'
    ? Effect.map(DateTime.now, (now) => Option.fromNullable(displayName(resource.name, now)))
    : Effect.succeed(Option.none())

export { maybeDisplayName }
