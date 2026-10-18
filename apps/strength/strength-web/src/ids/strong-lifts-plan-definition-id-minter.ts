import { mintResourceId } from './mint-resource-id.ts'

/**
 * The id the StrongLifts 5×5 template is stored under if a lifter starts it,
 * per lifter (their `patientId`): minted the first time it is asked for and
 * remembered, so the same lifter names the same id on every call for the
 * visit, a retried start on any tab included, and two lifters never share
 * one.
 */
const strongLiftsPlanDefinitionIdMinter = (): ((patientId: string) => string) => {
  const idsByPatientId = new Map<string, string>()
  return (patientId) => {
    const id = idsByPatientId.get(patientId) ?? mintResourceId()
    idsByPatientId.set(patientId, id)
    return id
  }
}

export { strongLiftsPlanDefinitionIdMinter }
