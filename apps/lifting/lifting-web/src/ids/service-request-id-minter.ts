import { mintResourceId } from './mint-resource-id.ts'

/**
 * The `mintServiceRequestId` for one start of a training plan definition: an
 * id minted the first time an exercise asks for one, then remembered, so a
 * retry names the same `ServiceRequest`s.
 */
const serviceRequestIdMinter = (): ((exerciseId: string) => string) => {
  const mintedIds = new Map<string, string>()
  return (exerciseId) => {
    const known = mintedIds.get(exerciseId)
    if (known !== undefined) return known
    const minted = mintResourceId()
    mintedIds.set(exerciseId, minted)
    return minted
  }
}

export { serviceRequestIdMinter }
