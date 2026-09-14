import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { ImagingStudy } from '../resources/imaging-study/index.ts'
import { SearchParams as ImagingStudySearchParams } from '../resources/imaging-study/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'ImagingStudy',
  ImagingStudy.Schema,
  ImagingStudySearchParams
)

export { httpApiGroup }
