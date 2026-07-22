import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { DocumentReference } from '../resources/document-reference/index.ts'
import { SearchParams as DocumentReferenceSearchParams } from '../resources/document-reference/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'DocumentReference',
  DocumentReference.Schema,
  DocumentReferenceSearchParams
)

export { httpApiGroup }
