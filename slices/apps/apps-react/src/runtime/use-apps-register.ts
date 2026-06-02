import { AppsBridge } from 'apps-core/bridge'
import { makeUseSliceRegister } from 'effect-messaging-react'

/**
 * Slice-bound coordinator accessor: returns `register` / `unregister`
 * already pre-applied to `AppsBridge`, so consumers see a
 * `(handlers) => Effect` pair typed against the apps slice's `HostToWeb`
 * schema. Reads the surrounding `HandlerCoordinatorContext`.
 */
const useAppsRegister = makeUseSliceRegister(AppsBridge)

export { useAppsRegister }
