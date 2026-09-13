import { makeUseSliceRegister } from 'effect-messaging-react'
import { HarRecorderBridge } from 'har-recorder-core'

/**
 * Slice-bound coordinator accessor for {@link HarRecorderBridge}: `register` /
 * `unregister` pre-applied to the recorder's own bridge, so consumers see a
 * `(handlers) => Effect` pair typed against its `HostToWeb` schemas
 * (`HarSaved` / `HarSaveFailed`). Reads the surrounding
 * `HandlerCoordinatorContext`.
 */
const useHarRecorderRegister = makeUseSliceRegister(HarRecorderBridge)

export { useHarRecorderRegister }
