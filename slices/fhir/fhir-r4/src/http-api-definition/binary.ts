import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { Binary } from '../resources/binary/index.ts'
import { SearchParams as BinarySearchParams } from '../resources/binary/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup('Binary', Binary.Schema, BinarySearchParams)

export { httpApiGroup }
