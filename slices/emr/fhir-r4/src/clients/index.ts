export {
  classifyAgainstServer,
  type DiffStatus,
  diffKey,
  normalizedEncode,
  resetFieldToServer,
  SERVER_MANAGED_META_FIELDS,
  type ServerComparison,
} from './classify-against-server.ts'
export {
  diffJson,
  formatPath,
  formatSlot,
  type DiffSlot,
  type FieldDiff,
  type PathSegment,
} from './field-diff.ts'
export {
  FhirR4ResourcesHttpApiClient,
  type FhirR4ResourcesHttpApiClientShape,
} from './fhir-r4-resources-http-api-client.ts'
export {
  type BatchEntryOutcome,
  entryUrl,
  NO_RESPONSE_STATUS,
  persistBatchBundle,
  statusOk,
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
