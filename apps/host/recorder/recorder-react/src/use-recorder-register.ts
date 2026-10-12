import { makeUseSliceRegister } from '@wildflowerhealthio/effect-messaging-react'
import { RecorderBridge } from '@wildflowerhealthio/recorder-core-js'

/**
 * Coordinator accessor for {@link RecorderBridge}: `register` / `unregister`
 * pre-applied to the recorder's bridge, so consumers see a
 * `(handlers) => Effect` pair typed against its `HostToWeb` schemas. Reads the
 * surrounding `HandlerCoordinatorContext`.
 */
const useRecorderRegister = makeUseSliceRegister(RecorderBridge)

export { useRecorderRegister }
