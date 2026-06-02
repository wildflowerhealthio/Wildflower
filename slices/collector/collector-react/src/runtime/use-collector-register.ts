import { CollectorBridge } from 'collector-fundamentals/bridge'
import { makeUseSliceRegister } from 'effect-messaging-react'

/**
 * Slice-bound coordinator accessor: returns `register` / `unregister`
 * already pre-applied to `CollectorBridge`, so consumers see a
 * `(handlers) => Effect` pair typed against the collector's `HostToWeb`
 * schema. Reads the surrounding `HandlerCoordinatorContext`.
 */
const useCollectorRegister = makeUseSliceRegister(CollectorBridge)

export { useCollectorRegister }
