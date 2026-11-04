import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { HttpResponseKind } from '@wildflowerhealthio/http-extraction-fundamentals'

import { MedicationListResponseKind } from './response-kinds/medication-list-response-kind.ts'
import { ProfileResponseKind } from './response-kinds/profile-response-kind.ts'

/**
 * The two Rexall response kinds — Profile, MedicationList — each yielding
 * detached records keyed under `REXALL_STU3_BASE_URL`: the profile's Patient
 * written detached in `<base>/Patient`, carebook's medications detached from
 * its searchset. A module-level
 * constant (stable by identity) the archive importer consumes by reference;
 * the two patterns are disjoint, so order is not load-bearing.
 */
const rexallBeWellResponseKinds: readonly HttpResponseKind.HttpResponseKind<DetachedResource.Type>[] =
  [ProfileResponseKind, MedicationListResponseKind]

export { rexallBeWellResponseKinds }
