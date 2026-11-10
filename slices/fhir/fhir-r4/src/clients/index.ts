export {
  classifyAgainstServer,
  type DiffStatus,
  normalizedEncode,
  resetFieldToServer,
  SERVER_MANAGED_META_FIELDS,
  type ServerComparison,
  withoutServerManagedMeta,
} from './classify-against-server.ts'
export {
  diffJson,
  formatPath,
  formatSlot,
  type DiffSlot,
  type FieldDiff,
  type PathSegment,
} from './field-diff.ts'
export { trimTrailingSlashes } from './fhir-base-url.ts'
export { operationOutcomeTextOf } from './operation-outcome-text.ts'
export * as ResourceWrite from './resource-write.ts'
export {
  matchesIn,
  MatchWithoutResource,
  NEXT_RELATION,
  nextPageToken,
  PAGE_TOKEN_PARAM,
  type PageLink,
  PageTokenRepeated,
  searchAllPages,
  searchEveryPage,
  type SearchPages,
  type SearchsetEntry,
  type SearchsetPage,
} from './search-pages.ts'
export {
  FhirR4ResourcesHttpApiClient,
  type FhirR4ResourcesHttpApiClientShape,
} from './fhir-r4-resources-http-api-client.ts'
export {
  BatchEntriesRejected,
  type BatchEntryOutcome,
  groupByStatus,
  NO_RESPONSE_STATUS,
  persistBatchBundle,
  persistBatchBundleOrFail,
  persistTransactionBundle,
  statusOk,
  type StatusGroup,
  type WriteIssue,
} from './persist-batch-bundle.ts'
export {
  describeResource,
  persistResources,
  type ResourceWriteFailure,
  type ResourceWriteTarget,
  WRITE_CONCURRENCY,
} from './persist-resources.ts'
export { upsertResource, UnsupportedFhirResourceTypeError } from './upsert-resource.ts'
