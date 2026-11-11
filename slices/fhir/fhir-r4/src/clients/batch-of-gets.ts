import type * as Bundle from '../data-types/resources/bundle.ts'

/**
 * A `batch` Bundle reading each of `urls`, in order, with a `GET` entry.
 *
 * @param urls - Each entry's `request.url`, relative to the FHIR base
 *   (`Patient/123`, `Patient?family=Smith`)
 */
const batchOfGets = (urls: readonly string[]): Bundle.BundleValue<unknown> => ({
  resourceType: 'Bundle' as const,
  type: 'batch' as const,
  id: null,
  implicitRules: null,
  language: null,
  meta: null,
  identifier: null,
  link: [],
  signature: null,
  timestamp: null,
  total: null,
  entry: urls.map((url) => ({
    id: null,
    extension: [],
    modifierExtension: [],
    fullUrl: null,
    link: [],
    request: {
      id: null,
      extension: [],
      modifierExtension: [],
      method: 'GET' as const,
      url,
      ifNoneMatch: null,
      ifModifiedSince: null,
      ifMatch: null,
      ifNoneExist: null,
    },
    resource: null,
    response: null,
    search: null,
  })),
})

export { batchOfGets }
