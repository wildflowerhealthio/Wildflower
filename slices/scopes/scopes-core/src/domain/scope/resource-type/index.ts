import Fhir from './fhir-resource.ts'
import Base from './resource-type.ts'
import Wildflower from './wildflower-resource.ts'

type Any = Fhir | Wildflower

const parse = (s: string): Any | null => {
  const fhir = Fhir.parse(s)
  if (fhir !== null) return fhir

  const wildflower = Wildflower.parse(s)
  if (wildflower !== null) return wildflower

  return null
}
export { Fhir, Wildflower, Base, type Any, parse }
